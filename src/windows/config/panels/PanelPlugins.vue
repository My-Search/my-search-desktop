<script setup lang="ts">
/**
 * 插件管理面板 —— Android 式权限管理 + 系统式自启动/后台进程管理。
 *
 * 本面板只做**展示与协调**，不做模拟文件系统操作（这在浏览器里跑不了）。
 * 文件安装与开发挂载仅 Tauri 环境可用，由 ipc 层处理浏览器兼容降级。
 *
 * 设计原则：
 *   - 清单里的 autostart 只是「请求」，有效策略存在 autoStart 字段
 *   - 不写 settings_store，全部操作注册表（localStorage）后 reconcile
 *   - **列表里只有插件**：订阅数据里的 [脚本] 项不是插件（没有清单、没有权限
 *     模型），不在这里露面；结果列表继续照常渲染它们。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePluginRuntime } from "../usePluginRuntime";
import {
  isKnownPermission,
  groupPermissions,
  summarizePermissions,
  type PermissionGroupBlock,
} from "../../../lib/plugins/permissions";
import { type AutoStartMode, type BehaviorSuggestion, type CloseBehavior, behaviorSuggestionOf } from "../../../lib/plugins/registry";
import { readPluginBinary, readLocalFileBase64 } from "../../../lib/plugins/ipc";
import { iconDataUrl, iconRefsOf, isInlineIconRef, primaryIconRef } from "../../../lib/plugins/icon";
import { markPluginFrontendRestart } from "../../../lib/plugins/restart";
import { builtinList, builtinMarkRemoved, builtinClearRemoved, builtinResourcePath } from "../../../lib/plugins/builtin";
import { openPluginView } from "../../../lib/tauri-bridge";
import { preparePackageFromBase64 } from "../../../lib/plugins/install";
import { envGrantsOf, envPermissionOf } from "../../../lib/plugins/env-store";
import EnvPicker from "../../../components/EnvPicker.vue";
import PluginInstallDialog from "../../../components/PluginInstallDialog.vue";
import { useEnvPicker } from "../../../composables/useEnvPicker";
import type { PluginManifest, PluginThemePreference } from "../../../lib/plugins/manifest";
import { compareVersion, detailViewThemeOf } from "../../../lib/plugins/manifest";
import { findPlugin, loadRegistry } from "../../../lib/plugins/registry";

const props = defineProps<{
  notify: (text: string, type?: "ok" | "error") => void;
  confirm: (text: string, opts?: { okText?: string; cancelText?: string }) => Promise<boolean>;
  /** 双击 .mspp 外部打开的待安装路径（App.vue 切到本面板后传入） */
  pendingPluginPath?: string | null;
  /** 本面板消费完待安装路径后回调（App.vue 据此置空，避免重复触发） */
  onPendingPluginPathConsumed?: () => void;
}>();

const rt = usePluginRuntime();

/** 环境变量授权选择器（宿主 UI；本面板「选择变量…」用它） */
const envPicker = useEnvPicker();

// ===================== 内置插件状态 =====================
const builtinEntries = ref<Awaited<ReturnType<typeof builtinList>>>([]);
/** 某 id 是否为内置插件 */
function isBuiltin(id: string): boolean {
  return builtinEntries.value.some((e) => e.id === id);
}
/**
 * 取插件的「首页」地址：repository（官方仓库/源码目录）优先，缺失时退回 homepage。
 *
 * 两者合并成一条链接展示——它们本来就是同一个插件的首页地址，分成「源码」「仓库」
 * 「主页」多行只会让用户困惑；统一叫「首页」。（市场卡片同口径。）
 */
function homepageOf(record: { repository?: string; homepage?: string }): string | undefined {
  return record.repository || record.homepage || undefined;
}
/** 取内置插件条目（可能为空=非内置/未读取） */
function builtinOf(id: string) {
  return builtinEntries.value.find((e) => e.id === id);
}

/** 刷新内置插件列表 */
async function refreshBuiltins(): Promise<void> {
  try {
    // 归一化为数组：IPC 返回 null/非数组（如宿主未实现该命令、桥接降级）时，
    // 模板里的 builtinEntries.filter/some/find 会因 null 抛错并中断整个面板渲染。
    // 这里兜底成空数组，保证插件面板始终能渲染（其余功能不受影响）。
    const list = await builtinList();
    builtinEntries.value = Array.isArray(list) ? list : [];
  } catch (e) {
    builtinEntries.value = [];
  }
}

/** 恢复一个被移除的内置插件 */
async function restoreBuiltin(id: string): Promise<void> {
  const entry = builtinOf(id);
  if (!entry || !entry.available) {
    props.notify(`内置插件 ${id} 的资源包不存在`, "error");
    return;
  }
  try {
    await builtinClearRemoved(id);
    const path = entry.resourcePath!;
    const b64 = await readLocalFileBase64(path);
    const prepared = await preparePackageFromBase64(b64, {
      hostVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
      checkPermissions: isKnownPermission,
    });
    const allPerms = [...(prepared.manifest.permissions ?? []), ...(prepared.manifest.optionalPermissions ?? [])];
    await rt.installFromFiles({
      manifest: prepared.manifest,
      dir: `plugins/${prepared.manifest.id}`,
      files: prepared.files,
      source: { kind: "builtin" },
      sha256: prepared.sha256,
      grants: allPerms,
    });
    await refreshBuiltins();
    // 卸载时忘掉了该插件的图标缓存；恢复后必须重新预读，否则 logo 不回来，
    // 只显示 🧩 占位图。
    forgetIconCache(prepared.manifest.id);
    await preloadIcons();
    props.notify(`已恢复内置插件「${prepared.manifest.name}」`, "ok");
  } catch (e) {
    props.notify(`恢复失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

// ===================== 筛选 =====================
type FilterMode = "all" | "running" | "error";
const filterMode = ref<FilterMode>("all");
const showDev = ref(true);
const discardedExpanded = ref(false);
/** 正在卸载中的插件 id（卸载可能较久，期间按钮显示"卸载中…"） */
const uninstallingId = ref<string | null>(null);

const runningCount = computed(() => rt.runningCount());

/** 列表里的记录（真插件；历史遗留的 legacy 投影记录在挂载时已清理） */
const plugins = computed(() => rt.registry.plugins.filter((p: any) => p.source.kind !== "legacy"));

/** 插件市场（内置插件）的 id：「从插件市场安装」按钮用它打开市场界面 */
const MARKET_PLUGIN_ID = "com.mysearch.market";

/**
 * 市场插件是否已安装 —— 决定工具栏是否显示「从插件市场安装」。
 *
 * 两个来源取或：本面板的注册表快照（用户在面板里装/卸会即时反映），以及
 * Rust 侧内置插件清单的 installed（内置自动安装可能晚于本面板挂载完成，
 * 那时快照里还没有记录，但磁盘上已经装好了）。
 */
const marketInstalled = computed(
  () =>
    plugins.value.some((p: any) => p.id === MARKET_PLUGIN_ID) ||
    builtinEntries.value.some((e) => e.id === MARKET_PLUGIN_ID && e.installed)
);

const displayList = computed(() => {
  const items: any[] = [];
  for (const rec of plugins.value) {
    if (!showDev.value && rec.source.dev) continue;
    const s = rt.runtimeOf(rec.id);
    if (filterMode.value === "running" && s.status !== "running" && s.status !== "starting") continue;
    if (filterMode.value === "error" && s.status !== "error" && s.status !== "crashed") continue;
    items.push(rec);
  }
  items.sort((a, b) => {
    const aBuiltin = isBuiltin(a.id) ? 1 : 0;
    const bBuiltin = isBuiltin(b.id) ? 1 : 0;
    if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin;
    return (b.installedAt ?? 0) - (a.installedAt ?? 0);
  });
  return items;
});

// ===================== 插件 logo =====================
/**
 * 图标缓存：`<插件id>/<图标引用>` → 可直接用于 `<img src>` 的 data URL。
 *
 * 清单里的图标可以是**插件目录内的相对路径**（如 `icon.svg`），读它要走异步
 * IPC，因此挂载后统一预读一次；`data:` / `http(s):` 自带完整地址，无需读取。
 */
const iconMap = ref<Record<string, string>>({});
/** 加载失败的插件 id（网络图标不可达 / 文件读不到）→ 回退到默认图标 */
const iconFailed = ref<Record<string, true>>({});

/** 取某插件可渲染的 logo（未就绪 / 已知失败返回 undefined，模板退回默认图标） */
function iconOf(rec: any): string | undefined {
  if (iconFailed.value[rec.id]) return undefined;
  const ref = primaryIconRef(rec.manifest);
  if (!ref) return undefined;
  return isInlineIconRef(ref) ? ref : iconMap.value[`${rec.id}/${ref}`];
}

/** 图标加载失败（多为网络地址不可达）→ 换回默认图标，不留碎图 */
function onIconError(rec: any): void {
  iconFailed.value[rec.id] = true;
}

/**
 * 忘掉某插件的图标缓存与失败标记。
 *
 * 卸载时调用：不这么做的话，重装 / 从「已丢弃」恢复后 `iconOf` 会命中残留的
 * 「加载失败」标记或缺失的缓存键，插件明明有 logo 却仍显示 🧩 占位图。
 */
function forgetIconCache(id: string): void {
  for (const k of Object.keys(iconMap.value)) {
    if (k.startsWith(`${id}/`)) delete iconMap.value[k];
  }
  delete iconFailed.value[id];
}

/** 预读全部插件的相对路径图标（失败只记日志，不影响面板可用） */
async function preloadIcons(): Promise<void> {
  for (const rec of plugins.value) {
    for (const ref of iconRefsOf(rec.manifest)) {
      const key = `${rec.id}/${ref}`;
      if (iconMap.value[key]) continue;
      try {
        iconMap.value[key] = iconDataUrl(ref, await readPluginBinary(rec.id, ref));
      } catch (e) {
        console.warn(`[插件] 读取图标失败（${rec.id} / ${ref}）:`, e);
      }
    }
  }
}

// ===================== 展开 =====================
const expanded = ref<Record<string, boolean>>({});
function toggleExpand(id: string): void {
  const next = !expanded.value[id];
  // 手风琴：展开某项时收起其它已展开项
  expanded.value = next ? { [id]: true } : {};
  // 收起当前插件（或切到别的插件）时，内联的权限明细一并消失
  if (permPanel.value && expanded.value[permPanel.value.pluginId] !== true) permPanel.value = null;
}

// ===================== 行为设置（关闭界面时 / 开机自启） =====================
/**
 * 两个「插件声明默认值、用户可改」的开关。
 *
 * 共同规则（与 autostart 既有设计一致）：
 *   - 清单里写的只是**建议**，面板显示「插件建议：…」；
 *   - 「开机自启」的缺省建议值是**开机自启**（作者未声明 autostart 时安装后即常驻），
 *     作者显式声明 on-demand / prompt / never 则按声明走；
 *   - 用户改过之后以用户值为准，插件升级（upsertPlugin）不会覆盖；
 *   - 「恢复默认」把值写回插件建议值。
 */
const autoStartOptions = [
  { value: "always" as AutoStartMode, label: "开机自启", desc: "随桌面版启动即常驻后台" },
  { value: "on-demand" as AutoStartMode, label: "按需启动", desc: "仅在使用时运行，空闲后自动停止" },
  { value: "never" as AutoStartMode, label: "从不自启", desc: "需手动启动" },
];

/**
 * 「关闭界面时」两个选项。
 *
 * 这一个开关同时管两件事（用户只理解一个概念）：
 *   - **插件界面**：最小化 = 界面留在后台保活（DOM / 输入草稿 / 滚动位置 /
 *     脚本内存态全保留，再打开是「恢复」而不是重新加载）；退出 = 卸载界面，
 *     下次打开重新读取入口文件并重新执行脚本；
 *   - **后台进程**（仅带 backend 的插件）：最小化 = 进程继续运行、交给空闲
 *     回收；退出 = 关闭界面即停止进程。
 *
 * 因此纯前端插件也显示这一行（它只体现界面那一半）。
 */
const closeBehaviorOptions = [
  {
    value: "minimize" as CloseBehavior,
    label: "最小化",
    desc: "界面保留在后台，状态不丢，再打开立即恢复；有后台进程的继续运行，空闲后自动退出",
  },
  {
    value: "exit" as CloseBehavior,
    label: "退出",
    desc: "界面卸载，下次打开重新加载；有后台进程的立即停止",
  },
];

/** 插件声明的建议值（面板上展示与「恢复默认」用） */
function suggestionOf(rec: any): BehaviorSuggestion {
  return behaviorSuggestionOf(rec.manifest);
}

/**
 * 「界面主题」三个选项。
 *
 * 语义：打开该插件视图时，宿主会把**整个呼出窗口**临时切成这里选定的主题
 * （搜索框 / 结果列表 / 插件面板同色），关闭插件后恢复软件原主题——避免
 * 「软件浅色 + 深色设计稿插件」出现上方浅、下方深的割裂观感。默认「跟随
 * 插件声明」，即用插件清单里的 `detailView.theme`。
 *
 * 插件自己在界面内也能改（如 pi-agent 左下角的主题切换，走
 * `ms.ui.registerThemeProvider`），那个运行时选择优先级高于这里的设置。
 */
const pluginThemeOptions = [
  { value: "inherit" as PluginThemePreference, label: "跟随插件声明", desc: "用插件清单里的默认主题（插件自己也能在界面内切换）" },
  { value: "dark" as PluginThemePreference, label: "深色", desc: "打开该插件时，呼出窗口整体切成深色" },
  { value: "light" as PluginThemePreference, label: "浅色", desc: "打开该插件时，呼出窗口整体切成浅色" },
];

const autoStartLabel = (mode: AutoStartMode): string =>
  autoStartOptions.find((o) => o.value === mode)?.label ?? mode;
const closeBehaviorLabel = (mode: CloseBehavior): string =>
  closeBehaviorOptions.find((o) => o.value === mode)?.label ?? mode;

/** 「跟随插件声明」在面板上要显示成实际的建议值，否则用户看不出会变成什么 */
const pluginThemeLabel = (mode: PluginThemePreference): string =>
  pluginThemeOptions.find((o) => o.value === mode)?.label ?? mode;
function pluginThemeSuggestText(rec: any): string {
  const t = detailViewThemeOf(rec.manifest);
  return t === "dark" ? "深色" : t === "light" ? "浅色" : "跟随宿主主题";
}

/** 面板上「插件建议」的文案（prompt 表示作者把决定权交给用户） */
function autoStartSuggestText(rec: any): string {
  const s = suggestionOf(rec);
  return s.fromPrompt ? "由你决定" : autoStartLabel(s.autoStart);
}

/** 用户是否改过开机自启（决定要不要显示「恢复」） */
function autoStartModified(rec: any): boolean {
  return rec.autoStart !== suggestionOf(rec).autoStart;
}
/** 用户是否改过关闭行为 */
function closeBehaviorModified(rec: any): boolean {
  return rec.closeBehavior !== suggestionOf(rec).closeBehavior;
}
/** 用户是否改过界面主题（与插件声明的建议值比较） */
function pluginThemeModified(rec: any): boolean {
  return (rec.themePreference ?? "inherit") !== detailViewThemeOf(rec.manifest);
}
/** 有界面的插件才谈「界面主题」 */
function showsPluginThemeRow(rec: any): boolean {
  return !!rec.manifest?.contributes?.detailView;
}
/**
 * 开机自启时「关闭界面时」的**进程侧**不生效（进程常驻），但**界面侧仍然生效**
 * （界面要不要保留与进程常驻无关）。因此这里不再整行置灰，只在进程语义上提示。
 */
function closeBehaviorLocked(rec: any): boolean {
  return rec.autoStart === "always" && !!rec.manifest.backend;
}

/** 有界面的插件谈「界面保活」，有后台进程的插件谈「进程去留」——两者任一都显示该行 */
function showsCloseBehaviorRow(rec: any): boolean {
  return !!rec.manifest?.contributes?.detailView || !!rec.manifest?.backend;
}

async function setAutoStart(rec: any, mode: AutoStartMode): Promise<void> {
  if (!rec.manifest.backend) return;
  rec.autoStart = mode;
  rt.persist();
  try {
    await rt.reconcile(rec.id);
    props.notify(
      mode === "always" ? `${rec.name} 已开启开机自启` : mode === "on-demand" ? `${rec.name} 已改为按需启动` : `${rec.name} 后台自启已关闭`,
      "ok"
    );
  } catch (e) {
    props.notify(`设置失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

/**
 * 关闭界面时的行为：落盘注册表即可（搜索窗口读取该值后自行决定
 * 「保活前端 / 卸载前端」与「是否停后台进程」，Rust 侧不需要知道）。
 */
function setCloseBehavior(rec: any, mode: CloseBehavior): void {
  rec.closeBehavior = mode;
  rt.persist();
  const hasBackend = !!rec.manifest.backend;
  props.notify(
    mode === "exit"
      ? hasBackend
        ? `${rec.name} 关闭界面时将卸载界面并停止后台进程`
        : `${rec.name} 关闭界面时将卸载界面（下次打开重新加载）`
      : hasBackend
        ? `${rec.name} 关闭界面后界面保留在后台，进程继续运行`
        : `${rec.name} 关闭界面后界面保留在后台（状态不丢）`,
    "ok"
  );
}

/**
 * 界面主题：落盘注册表即可。
 *
 * 搜索窗口在打开该插件视图时会读 `themePreference`（经 resolvePluginTheme），
 * 把整个呼出窗口临时切到该主题；这里不需要通知任何进程。若插件此刻正开着，
 * 下次打开（含最小化后的恢复）即生效。
 */
function setPluginTheme(rec: any, mode: PluginThemePreference): void {
  rec.themePreference = mode;
  rt.persist();
  props.notify(
    mode === "inherit"
      ? `${rec.name} 的界面主题已改为跟随插件声明`
      : `${rec.name} 打开时将把呼出窗口切为${mode === "dark" ? "深色" : "浅色"}`,
    "ok"
  );
}

/** 恢复插件建议的默认值（三项一起，避免用户分不清恢复了哪个） */async function restoreBehaviorDefaults(rec: any): Promise<void> {
  const s = suggestionOf(rec);
  const autoStartChanged = rec.autoStart !== s.autoStart;
  rec.autoStart = s.autoStart;
  rec.closeBehavior = s.closeBehavior;
  rec.themePreference = detailViewThemeOf(rec.manifest);
  rt.persist();
  try {
    if (autoStartChanged && rec.manifest.backend) await rt.reconcile(rec.id);
    props.notify(`已恢复「${rec.name}」的插件默认设置`, "ok");
  } catch (e) {
    props.notify(`设置失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

// ===================== 启停 =====================
async function toggleBackend(rec: any): Promise<void> {
  const s = rt.runtimeOf(rec.id);
  try {
    if (s.status === "running" || s.status === "starting") {
      await rt.stopBackend(rec.id);
      props.notify(`${rec.name} 已停止`, "ok");
    } else {
      // 启动前先把网关配置同步到 Rust 侧——否则 Rust 查不到记录，
      // spawn_backend 直接返回「插件未注册到网关」，前端表现为点了没反应
      await rt.reconcile(rec.id);
      await rt.startBackend(rec.id);
      props.notify(`${rec.name} 已启动`, "ok");
    }
  } catch (e) {
    props.notify(`操作失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

/**
 * 重启插件：后端进程重启 + 前端会话在下次打开时重新挂载（两件事都要做）。
 *
 * 后端重启走 `restartBackend`（Rust 侧 stop + spawn）；前端因为跑在**另一个
 * WebView**里，靠写入 localStorage 的「重启标记」把意图告诉搜索窗——否则那次
 * 保活ing的旧会话（内存里还是重启前的代码）会被 `decideViewRestore` 当作
 * 「入口没变」直接恢复，等于后端换了、界面还是旧的。
 *
 * 标记**先写**再重启后端：即使后端重启失败，前端「下次打开重新加载」的意图
 * 也保留（界面态与进程态本就相对独立，别让一处失败连坐另一处）。
 */
async function restartPlugin(rec: any): Promise<void> {
  if (!(await props.confirm(`确定重启「${rec.name}」？\n\n后台进程将重新启动，界面会在下次打开时重新加载。`))) return;
  markPluginFrontendRestart(rec.id);
  try {
    await rt.reconcile(rec.id);
    await rt.restartBackend(rec.id);
    props.notify(`${rec.name} 已重启（界面下次打开时重新加载）`, "ok");
  } catch (e) {
    props.notify(`重启失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

async function stopAll(): Promise<void> {
  if (!(await props.confirm("确定停止所有后台进程？\n"))) return;
  await rt.stopAllBackends();
  props.notify("已停止所有后台进程", "ok");
}

// ===================== 启用/禁用/卸载 =====================
async function toggleEnabled(rec: any): Promise<void> {
  await rt.setEnabled(rec.id, !rec.enabled);
  props.notify(rec.enabled ? `${rec.name} 已启用` : `${rec.name} 已禁用`, "ok");
}

/** 卸载确认文案：插件在后台运行时明确告知「卸载前会自动停止」 */
function uninstallConfirmText(rec: any, base: string): string {
  const s = rt.runtimeOf(rec.id);
  if (s.status === "running" || s.status === "starting") {
    return `${base}\n\n该插件正在后台运行，卸载前将自动停止其进程。`;
  }
  return base;
}

async function uninstallPlugin(rec: any): Promise<void> {
  if (uninstallingId.value) return;
  if (isBuiltin(rec.id)) {
    if (!(await props.confirm(uninstallConfirmText(rec, `「${rec.name}」是内置插件，卸载后将不再随版本升级自动安装。确定卸载？`)))) return;
    const deleteData = await props.confirm("是否同时删除插件保存的数据？", { cancelText: "保留" });
    uninstallingId.value = rec.id;
    try {
      await rt.uninstall(rec.id, deleteData);
      await builtinMarkRemoved(rec.id);
      await refreshBuiltins();
      forgetIconCache(rec.id);
      props.notify(`已卸载内置插件 ${rec.name}（升级不再自动安装）`, "ok");
    } catch (e) {
      props.notify(`卸载失败: ${String((e as Error)?.message ?? e)}`, "error");
    } finally {
      uninstallingId.value = null;
    }
    return;
  }
  if (!(await props.confirm(uninstallConfirmText(rec, `确定卸载「${rec.name}」v${rec.version}？`)))) return;
  const deleteData = await props.confirm("是否同时删除插件保存的数据？", { cancelText: "保留" });
  uninstallingId.value = rec.id;
  try {
    await rt.uninstall(rec.id, deleteData);
    // 清掉图标缓存里的残留键（重新安装时会再读一次）
    forgetIconCache(rec.id);
    props.notify(`已卸载 ${rec.name}`, "ok");
  } catch (e) {
    props.notify(`卸载失败: ${String((e as Error)?.message ?? e)}`, "error");
  } finally {
    uninstallingId.value = null;
  }
}

// ===================== 安装 =====================
// 插件安装确认弹窗（标题「插件安装」，展示 logo / 名称 / 版本 / 权限分组 / 警告）
const installDialogVisible = ref(false);
const installDialogManifest = ref<PluginManifest | null>(null);
const installDialogIcon = ref<string | null>(null);
const installDialogPerms = ref<PermissionGroupBlock[]>([]);
const installDialogWarnings = ref<string[]>([]);
/** 已安装版本（弹窗按钮据此显示 安装/重新安装/升级；null = 未安装） */
const installDialogInstalledVersion = ref<string | null>(null);
/** 该插件当前是否在后台运行（覆盖安装时弹窗提示「先停止再安装」） */
const installDialogRunning = ref(false);
/** 待安装的预处理结果（确认后直接落盘） */
let pendingPrepared: Awaited<ReturnType<typeof preparePackageFromBase64>> | null = null;
/** 待安装的 .mspp 文件路径（写入插件来源 source.ref） */
let pendingInstallPath = "";

/**
 * 从指定路径安装 .mspp（系统文件选择器 / 双击外部打开共用）。
 * 读取 → 解包校验 → 弹出安装确认弹窗；实际落盘在 onInstallConfirm。
 */
async function installFromPath(path: string): Promise<void> {
  try {
    const b64 = await readLocalFileBase64(path);
    // 解包 + 剥离包裹目录 + 校验清单（纯逻辑，错误文案已面向用户）
    const prepared = await preparePackageFromBase64(b64, {
      hostVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
      checkPermissions: isKnownPermission,
    });
    const mf = prepared.manifest;
    const allPerms = [...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])];

    // 构造 logo data URL（inline 引用直用；文件引用从包内 base64 生成）
    let iconUrl: string | null = null;
    const iconRef = mf.icon;
    if (iconRef) {
      if (isInlineIconRef(iconRef)) {
        iconUrl = iconRef;
      } else {
        const iconFile = prepared.files.find((f) => f.path === iconRef);
        if (iconFile) iconUrl = iconDataUrl(iconRef, iconFile.data);
      }
    }

    pendingPrepared = prepared;
    pendingInstallPath = path;
    installDialogManifest.value = mf;
    installDialogIcon.value = iconUrl;
    installDialogPerms.value = groupPermissions(allPerms);
    installDialogWarnings.value = prepared.warnings;
    // 直读注册表取已安装版本（另一窗口可能刚装过，比 rt 内存态更新）
    installDialogInstalledVersion.value = findPlugin(loadRegistry(), mf.id)?.version ?? null;
    // 后台是否在跑：覆盖安装时弹窗提示「会先停止再安装」
    const st = rt.runtimeOf(mf.id).status;
    installDialogRunning.value = st === "running" || st === "starting";
    installDialogVisible.value = true;
  } catch (e) {
    props.notify(`安装失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

/** 安装确认弹窗：用户点击「安装」 */
async function onInstallConfirm(): Promise<void> {
  installDialogVisible.value = false;
  if (!pendingPrepared) return;
  const prepared = pendingPrepared;
  const mf = prepared.manifest;
  const allPerms = [...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])];
  // 落盘前取原版本：成功后按 安装/重装/升级 给出对应文案
  const prevRec = findPlugin(loadRegistry(), mf.id);
  try {
    await rt.installFromFiles({
      manifest: mf,
      dir: `plugins/${mf.id}`,
      files: prepared.files,
      source: { kind: "file", ref: pendingInstallPath },
      sha256: prepared.sha256,
      grants: allPerms,
    });
    const cmp = prevRec ? compareVersion(mf.version, prevRec.version) : null;
    const verb = cmp === null ? "已安装" : cmp === 0 ? "已重新安装" : "已升级";
    props.notify(`${verb}「${mf.name}」v${mf.version}`, "ok");
    // 覆盖安装（升级 / 重装）可能换了 logo：先忘掉旧缓存与「加载失败」标记再预读，
    // 否则改过图标的插件会一直显示旧图或占位图。
    forgetIconCache(mf.id);
    await preloadIcons();
  } catch (e) {
    props.notify(`安装失败: ${String((e as Error)?.message ?? e)}`, "error");
  } finally {
    pendingPrepared = null;
    pendingInstallPath = "";
    installDialogManifest.value = null;
    installDialogIcon.value = null;
    installDialogInstalledVersion.value = null;
    installDialogRunning.value = false;
  }
}

/** 安装确认弹窗：用户点击「取消」 */
function onInstallCancel(): void {
  installDialogVisible.value = false;
  pendingPrepared = null;
  pendingInstallPath = "";
  installDialogManifest.value = null;
  installDialogIcon.value = null;
  installDialogInstalledVersion.value = null;
  installDialogRunning.value = false;
}

async function installFromFile(): Promise<void> {
  const { pickPluginPackage } = await import("../../../lib/plugins/ipc");
  const path = await pickPluginPackage();
  if (!path) return;
  await installFromPath(path);
}

async function installDevDir(): Promise<void> {
  try {
    const { pickPluginDir } = await import("../../../lib/plugins/ipc");
    const dir = await pickPluginDir();
    if (!dir) return;
    // 先读取 manifest（Rust 侧 plugin_read_dev_manifest），再由 rt 层完成挂载
    const { readDevManifest } = await import("../../../lib/plugins/ipc");
    const manifestText: string = await readDevManifest(dir);
    const record = await rt.installDevDir(manifestText, dir);
    props.notify(`已挂载「${record.name}」v${record.version}（开发模式）`, "ok");
    forgetIconCache(record.id);
    await preloadIcons();
  } catch (e) {
    props.notify(`挂载失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

/**
 * 打开插件市场界面（工具栏「从插件市场安装」）。
 *
 * 市场界面在主搜索窗口里渲染：Rust 侧收起设置窗口、呼出主窗口并广播事件，
 * 由那边的既有路径打开详情视图。这里只多做一道「已禁用」的前置提示——
 * 禁用时主窗口只会弹一个 toast 而设置窗口已经收起，用户会觉得「点了没反应」。
 */
async function openMarket(): Promise<void> {
  const rec = rt.get(MARKET_PLUGIN_ID);
  if (rec && !rec.enabled) {
    props.notify(`「${rec.name}」已禁用，请先启用后再打开插件市场`, "error");
    return;
  }
  try {
    await openPluginView(MARKET_PLUGIN_ID);
  } catch (e) {
    props.notify(`打开插件市场失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

// ===================== 环境变量授权 =====================
/**
 * 已授权给该插件的环境变量名（`env.read:<NAME>`）。
 * 未授权的变量对插件不可见——这里只列**已授权**的，撤销也按项来。
 */
function envNamesOf(rec: any): string[] {
  return [...envGrantsOf(rec)].sort();
}

/**
 * 打开环境变量选择器（宿主 UI）。
 *
 * 设置窗口与搜索窗口是**两个独立 WebView**：插件界面里的选择器由搜索窗口画，
 * 这里由设置窗口自己画一份（同一个 EnvPicker 组件）。选中的变量当场授权给该插件，
 * 并立即重算网关（值只在 spawn 时进进程，所以顺带重启在跑的后台进程）。
 */
async function grantEnv(rec: any): Promise<void> {
  const picked = await envPicker.openEnvPicker({
    pluginId: rec.id,
    pluginName: rec.name,
    title: "为该插件授权环境变量",
    granted: envNamesOf(rec),
    grant: async (name: string) => {
      const ok = rt.grant(rec.id, envPermissionOf(name));
      if (!ok) return false;
      await rt.syncEnvToPlugins();
      return true;
    },
  });
  if (!picked) return;
  props.notify(`已授权「${rec.name}」使用环境变量 ${picked.kind === "ref" ? picked.name : "（手工值）"}。`, "ok");
}

async function revokeEnv(rec: any, name: string): Promise<void> {
  if (!(await props.confirm(`撤销「${rec.name}」对 ${name} 的使用授权？\n\n撤销后它的后台进程会重启，且不再收到该变量。`))) return;
  rt.revoke(rec.id, envPermissionOf(name));
  await rt.syncEnvToPlugins();
  props.notify(`已撤销 ${name} 的授权。`, "ok");
}

// ===================== 权限面板 =====================
// 权限明细内联展开在对应插件的详情区（「权限」行下方），而不是页面底部的独立卡片，
// 避免多个插件时详情出现在最后一个插件下面的错位感。
const permPanel = ref<{ pluginId: string; blocks: PermissionGroupBlock[]; record: any } | null>(null);
function buildPermPanel(rec: any): NonNullable<typeof permPanel.value> {
  const allPerms = [...(rec.manifest.permissions ?? []), ...(rec.manifest.optionalPermissions ?? [])];
  return { pluginId: rec.id, blocks: groupPermissions(allPerms.filter((p: string) => rec.grants.some((g: any) => g.permission === p))), record: rec };
}
function showPermissions(rec: any): void {
  permPanel.value = permPanel.value?.pluginId === rec.id ? null : buildPermPanel(rec);
}
function closePerms(): void {
  permPanel.value = null;
}
async function revokePerm(pluginId: string, permission: string): Promise<void> {
  rt.revoke(pluginId, permission);
  const rec = rt.get(pluginId);
  if (rec && permPanel.value?.pluginId === pluginId) permPanel.value = buildPermPanel(rec);
}

// ===================== 日志 =====================
const logPanel = ref<{ pluginId: string; content: string } | null>(null);
async function showLog(rec: any): Promise<void> {
  const content = await rt.logOf(rec.id, 200);
  logPanel.value = { pluginId: rec.id, content: content || "(日志为空)" };
}

// ===================== 生命周期 =====================
onMounted(() => {
  purgeLegacyRecords();
  void rt.reconcileAll();
  void preloadIcons();
  void refreshBuiltins();
  // 目录挂载插件的热重载：面板打开期间跟随源目录变化刷新展示
  void rt.startDevWatcher();
});

// 双击 .mspp 外部打开：App.vue 切到本面板并传入路径 → 弹安装确认。
// 消费后立即回调置空，保证同一路径不会被重复触发。
watch(
  () => props.pendingPluginPath,
  (path) => {
    if (!path) return;
    void installFromPath(path).finally(() => props.onPendingPluginPathConsumed?.());
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  rt.stopDevWatcher();
});

/**
 * 清理历史遗留的「legacy 脚本项」记录。
 *
 * 早期版本把订阅数据里的 `[脚本]` 项投影成伪插件记录塞进注册表，好让面板用同一
 * 套渲染列出来——但它们既没有清单也没有权限模型，`enabled` 开关对前台毫无影响
 * （搜索结果始终照常渲染脚本项），留在注册表里只会污染「已安装」计数与列表。
 * 这里在面板挂载时一次性清除（记录是自动生成的，不含用户数据）。
 */
function purgeLegacyRecords(): void {
  const stale = rt.registry.plugins.filter((p: any) => p.source?.kind === "legacy");
  if (stale.length === 0) return;
  rt.registry.plugins = rt.registry.plugins.filter((p: any) => p.source?.kind !== "legacy");
  rt.persist();
  console.info(`[插件] 已清理 ${stale.length} 条历史遗留的脚本项记录（脚本项不是插件）`);
}

// 工具函数
function statusParts(pId: string): string[] {
  const s = rt.runtimeOf(pId);
  const parts: string[] = [s.status];
  if (s.pid) parts.push(`PID ${s.pid}`);
  if (s.lastError) parts.push(`错误: ${s.lastError}`);
  return parts;
}
function formatMem(bytes: number | null): string {
  if (!bytes) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
function durFrom(ts: number | null): string {
  if (!ts) return "";
  const sec = Math.floor((Date.now() - ts) / 1000);
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}
</script>

<template>
  <section class="page plugins">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>插件管理</h3>
        <span class="cfg-hint">安装 · 权限 · 后台进程</span>
      </div>
    </div>

    <div class="cfg-card plugins-toolbar">
      <div class="plugins-stats">
        <span>已安装 {{ plugins.length }}</span>
        <span v-if="runningCount > 0" class="plugins-running">● {{ runningCount }} 后台运行</span>
        <span v-else class="plugins-idle">○ 无后台进程</span>
      </div>
      <div class="plugins-actions">
        <button v-if="marketInstalled" class="btn-sm" title="打开插件市场，浏览并安装插件" @click="openMarket()">
          <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M512 161.44a192.064 192.064 0 0 1 189.12 158.528l35.84 0.032a64 64 0 0 1 63.52 56.224l54.72 448A64 64 0 0 1 791.744 896H232.288a64 64 0 0 1-63.52-71.776l54.752-448A64 64 0 0 1 287.04 320h35.84A192.064 192.064 0 0 1 512 161.408zM736.96 384L704 383.968V448l-0.224 3.744A32 32 0 0 1 640 448v-64.032h-256V448l-0.224 3.744A32 32 0 0 1 320 448v-64.032L287.04 384 232.32 832h559.36l-54.72-448zM512 225.44a128.064 128.064 0 0 0-123.584 94.528h247.168A128.064 128.064 0 0 0 512 225.44z" />
          </svg>
          从插件市场安装
        </button>
        <button class="btn-sm" @click="installFromFile()">
          <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M541.866667 934.4l328.533333-192c12.8-8.533333 17.066667-17.066667 17.066667-34.133333V328.533333l-328.533334 192c-8.533333 4.266667-12.8 8.533333-17.066666 8.533334v405.333333z m-72.533334 0v-405.333333c-8.533333-4.266667-12.8-4.266667-17.066666-8.533334L119.466667 328.533333v379.733334c0 17.066667 8.533333 25.6 17.066666 34.133333l332.8 192z m384-669.866667l-328.533333-192c-12.8-8.533333-25.6-8.533333-38.4 0L157.866667 264.533333l328.533333 192c12.8 8.533333 25.6 8.533333 38.4 0L853.333333 264.533333zM908.8 213.333333c34.133333 17.066667 55.466667 55.466667 55.466667 98.133334v401.066666c0 42.666667-21.333333 76.8-55.466667 98.133334l-349.866667 200.533333c-34.133333 17.066667-76.8 17.066667-110.933333 0L98.133333 810.666667c-34.133333-17.066667-55.466667-55.466667-55.466666-98.133334V311.466667c0-42.666667 21.333333-76.8 55.466666-98.133334L448 12.8c34.133333-17.066667 76.8-17.066667 110.933333 0L908.8 213.333333z" />
          </svg>
          从文件安装
        </button>
        <button class="btn-sm" @click="installDevDir()">
          <svg viewBox="0 0 1056 1024" width="14" height="14" aria-hidden="true">
            <path d="M266.0317958 231.07929925l91.30758782-24.03438189 67.27320676 67.27320593-24.03630423 91.30758865-91.30758866 24.0343819-67.27320593-67.27320593 24.03630424-91.30758866z" fill="#40BF4F" />
            <path d="M301.36743111 220.20664858l55.58371299-14.18038137 69.73718664 70.96917701-24.03438273 88.84360793-58.04961519 12.94839103-67.27320594-67.27320593 24.03630423-91.30758867z" fill="#359941" />
            <path d="M593.13003014 428.87236655l-127.79064652 127.79064568 55.76053546 55.7624578 127.79064653-127.79064651-55.76053547-55.76245697z" fill="#A6A6A6" />
            <path d="M970.2824363 777.15084021L826.22413652 921.20913999 620.66241909 715.64742337l-56.06036417 56.06228649-349.94867597-93.76964703L120.88373191 327.99138687l62.85649192-62.85457041L405.59842457 486.99501721l97.17155475-97.17155474 0.68038139 0.67845986L727.29973399 166.65254822l93.48134985 348.87621039-56.06036416 56.06036416 205.56171661 205.56171744z" fill="#BFBFBF" />
            <path d="M408.31610708 483.41244318L726.70776344 166.65254822l10.31527634 29.07381884-328.7069327 330.68080839L184.07464876 302.16379562l-29.64464703 29.64464704 86.72366217 320.99017648 320.73455237 86.97928546 65.23590563-65.23590564 225.59645489 220.18223227-26.49644027 26.48490876-205.54826357-205.43678806-51.31306906 54.7168991-352.45301826-95.94725207L121.13551137 326.76131803 184.07464876 265.7364747l224.24145832 217.67596848z" fill="#999999" />
            <path d="M700.21708934 185.5802247l-181.13717285 181.13909518L314.20819126 161.84759384l62.85649192-62.85456958 323.15240616 86.58720044z" fill="#999999" />
            <path d="M344.0738662 202.58591943l-35.30103992-35.30103908-1.66635763-2.49473228-0.5862052-2.94255423 0.5862052-2.9406319 1.66635763-2.49473226 62.85457041-62.85649191 2.18721505-1.53181989 2.57929926-0.6899914 2.66002322 0.23256025L704.35127153 178.73028152l17.5130983-17.5150198 2.68116477-1.74131544 3.15781594-0.49971505 3.08670282 0.82837382 2.48512226 2.01039339 1.45109591 2.84837724 93.48134986 348.87813189c0.15568012 1.77206699 0.67653753 3.61909177-1.98925104 7.4246152l-50.625 50.625L981.15508696 777.15084021l-10.87265067 10.87265066-210.9970816-210.9970816-1.66635763-2.49473227-0.58620438-2.94255422 0.58620438-2.94255424 1.66635763-2.49280994 52.92176825-52.92176824L723.32123191 181.50370178l-214.43550705 214.43550706-3.15781594 1.79705237-94.69219784 94.69412016-2.49473227 1.66635847-2.94255424 0.58620438-2.94255422-0.58620438-2.49281077-1.66635847L183.74022383 276.00754562 129.45961434 330.29007663l91.47095727 341.37279355 341.37279273 91.47095645 52.92176824-52.92176825 2.49473227-1.66635764 2.94255423-0.58620437 2.94255424 0.58620437 2.49281075 1.66635764L837.09678719 921.20913999l-10.87265067 10.87265066-205.56171743-205.56171662-50.625 50.625c-1.45878442 1.02057248-2.7964833 2.39478909-7.42653754 1.98925105L212.66220559 685.36660037c-1.61254303-0.75149451-3.47109934-1.22430267-5.43536418-5.43536499L113.45911671 329.98063791c-0.15568012-1.77206699-0.67653753-3.61909177 1.98925105-7.42461603L178.30485967 259.69952998l2.49280993-1.66635765 2.94255423-0.58428286 2.94255423 0.58428286 2.49281076 1.66635764 48.58385504 48.58385587L258.59564824 229.1227221c0.82260847-2.60620697 1.82588242-4.32638086 5.47764807-5.47764806l80.00056989-21.05915461zM253.03343318 614.72223828l-3.70365876 1.03018167-64.90340303-233.38240274 3.70173724-1.03018249 64.90532455 233.38240356z m291.26480631-12.6735477l-13.31741217 7.687927-50.93059488-88.21704199 13.31548983-7.68792701 50.93251722 88.217042z m21.13987774-21.13987775l-13.31548983 7.68792701-50.93251722-88.2189635 13.31548985-7.687927 50.9325172 88.21896349z m21.13987692-21.14180008l-13.31548901 7.68792783-50.93251721-88.217042 13.31548984-7.687927 50.93251638 88.21704118z m21.14180009-21.13987692l-13.31741218 7.687927-50.93251721-88.21704198 13.31741217-7.68792701 50.93251722 88.217042z m21.13987774-21.13987775l-13.31548983 7.68792701-50.93251722-88.21896351 13.31548984-7.68792699 50.93251721 88.21896349z m-199.79000601-229.90553805l-21.05723227 80.00056906c-0.82260847 2.60620697-1.82588242 4.32638086-5.47764807 5.47764808l-79.16066373 20.8381267 82.22430267 82.22430268 91.73618977-91.73619059 3.15781677-1.79897469 11.79135763-11.79135847-83.21412277-83.21412277zM272.32436382 237.37186811l-21.77028754 82.70287536 61.02868716 61.02676566 82.70095469-21.77028755 21.77028753-82.70095385-61.02868799-61.02676565-82.70095385 21.76836603z m52.75647812-75.52427427l198.0755983 198.0755983 168.64044681-168.6385253L379.36145144 107.56698434l-54.2806095 54.2806095z m338.37258004 39.7485055l-0.99558709 3.71134643L380.13985366 129.56406595l0.9975086-3.71134644 282.31605972 75.74337983z" fill="#262626" />
          </svg>
          从目录挂载
        </button>
        <button v-if="runningCount > 0" class="btn-sm btn-warn" @click="stopAll()">全部停止</button>
      </div>
    </div>

    <div class="cfg-card plugins-filter">
      <button
        v-for="f in ([
          { value: 'all' as FilterMode, label: '全部' },
          { value: 'running', label: '后台运行中' },
          { value: 'error', label: '异常' },
        ] as const)"
        :key="f.value"
        class="btn-filter"
        :class="{ on: filterMode === f.value }"
        @click="filterMode = f.value"
      >{{ f.label }}
        <span v-if="f.value === 'running' && runningCount > 0" class="badge">{{ runningCount }}</span>
      </button>
    </div>

    <div class="cfg-card plugins-list" v-if="displayList.length > 0">
      <div
        v-for="record in displayList"
        :key="record.id"
        class="plugin-item"
        :class="{ 'is-disabled': !record.enabled, 'is-expanded': expanded[record.id] }"
        @click="toggleExpand(record.id)"
      >
        <div class="plugin-header">
          <div class="plugin-icon" :class="{ 'has-logo': !!iconOf(record) }">
            <img v-if="iconOf(record)" :src="iconOf(record)" alt="" @error="onIconError(record)" />
            <template v-else>🧩</template>
          </div>
          <div class="plugin-meta">
            <div class="plugin-name">{{ record.name }}<span v-if="record.author" class="plugin-author"> · {{ record.author }}</span><span v-if="isBuiltin(record.id)" class="tag-builtin">内置</span></div>
            <div class="plugin-desc">{{ record.description || '' }}</div>
          </div>
          <div class="plugin-state">
            <span v-if="record.manifest.backend" class="plugin-dot" :class="rt.runtimeOf(record.id).status" :title="statusParts(record.id).join(' · ')"></span>
            <span class="plugin-version">v{{ record.version }}</span>
          </div>
          <div class="plugin-arrow">{{ expanded[record.id] ? '▼' : '▶' }}</div>
        </div>

        <div v-if="expanded[record.id]" class="plugin-detail">
          <div class="plugin-info-row">
            <span class="plugin-info-label">状态</span>
            <label class="switch" :class="{ on: record.enabled }" @click.stop><input type="checkbox" :checked="record.enabled" @change="toggleEnabled(record)" /><span class="switch-track"><span class="switch-thumb"></span></span></label>
            <span>{{ record.enabled ? '已启用' : '已禁用' }}</span>
          </div>
          <div class="plugin-info-row"><span class="plugin-info-label">ID</span><code>{{ record.id }}</code></div>
          <div class="plugin-info-row" v-if="homepageOf(record)"><span class="plugin-info-label">首页</span><a :href="homepageOf(record)" target="_blank">{{ homepageOf(record) }}</a></div>

          <!-- 关闭界面时的行为（插件可声明建议，用户可改）
               有界面 → 决定界面是否保活；有后台进程 → 决定进程是否停止。
               因此「有界面」或「有 backend」的插件都显示这一行。 -->
          <div v-if="showsCloseBehaviorRow(record)" class="plugin-info-row">
            <span class="plugin-info-label">关闭界面时</span>
            <div @click.stop class="behavior-cell">
              <div class="backend-autostart">
                <button
                  v-for="opt in closeBehaviorOptions"
                  :key="opt.value"
                  class="btn-tiny"
                  :class="{ on: record.closeBehavior === opt.value }"
                  :title="opt.desc"
                  @click="setCloseBehavior(record, opt.value)"
                >{{ opt.label }}</button>
              </div>
              <div class="behavior-note">
                <span v-if="closeBehaviorLocked(record)" class="behavior-locked">已设为开机自启：进程常驻不会停；界面仍按此设置保留或卸载</span>
                <template v-else>
                  <span class="plugin-suggest">插件建议：{{ closeBehaviorLabel(suggestionOf(record).closeBehavior) }}</span>
                  <button v-if="closeBehaviorModified(record)" class="btn-link" @click="restoreBehaviorDefaults(record)">恢复</button>
                </template>
              </div>
            </div>
          </div>

          <!-- 界面主题（插件可声明建议，用户可改）
               打开该插件视图时，宿主会把整个呼出窗口临时切成这里选定的主题，
               关闭后恢复软件原主题——避免「软件浅色 + 深色设计稿插件」上方浅、
               下方深的割裂观感。插件自己也能在界面内改（运行时优先于这里）。 -->
          <div v-if="showsPluginThemeRow(record)" class="plugin-info-row">
            <span class="plugin-info-label">界面主题</span>
            <div @click.stop class="behavior-cell">
              <div class="backend-autostart">
                <button
                  v-for="opt in pluginThemeOptions"
                  :key="opt.value"
                  class="btn-tiny"
                  :class="{ on: (record.themePreference ?? 'inherit') === opt.value }"
                  :title="opt.desc"
                  @click="setPluginTheme(record, opt.value)"
                >{{ opt.label }}</button>
              </div>
              <div class="behavior-note">
                <span class="plugin-suggest">插件建议：{{ pluginThemeSuggestText(record) }}</span>
                <button v-if="pluginThemeModified(record)" class="btn-link" @click="restoreBehaviorDefaults(record)">恢复</button>
              </div>
            </div>
          </div>

          <!-- 开机自启（插件可声明建议，用户可改） -->
          <div v-if="record.manifest.backend" class="plugin-info-row">
            <span class="plugin-info-label">开机自启</span>
            <div @click.stop class="behavior-cell">
              <div class="backend-autostart">
                <button v-for="opt in autoStartOptions" :key="opt.value" class="btn-tiny" :class="{ on: record.autoStart === opt.value }" :title="opt.desc" @click="setAutoStart(record, opt.value)">{{ opt.label }}</button>
              </div>
              <div class="behavior-note">
                <span class="plugin-suggest">插件建议：{{ autoStartSuggestText(record) }}</span>
                <button v-if="autoStartModified(record)" class="btn-link" @click="restoreBehaviorDefaults(record)">恢复</button>
              </div>
            </div>
          </div>

          <!-- 后台进程（手动启停/重启） -->
          <div v-if="record.manifest.backend" class="plugin-info-row">
            <span class="plugin-info-label">后台进程</span>
            <div @click.stop>
              <div class="backend-buttons">
                <button v-if="!['running','starting'].includes(rt.runtimeOf(record.id).status)" class="btn-sm" @click="toggleBackend(record)">启动</button>
                <button v-else class="btn-sm btn-warn" @click="toggleBackend(record)">停止</button>
                <button class="btn-sm" title="重启后台进程；界面会在下次打开时重新加载" @click="restartPlugin(record)">重启</button>
              </div>
            </div>
          </div>

          <!-- 运行详情 -->
          <div v-if="rt.runtimeOf(record.id).status !== 'stopped'" class="plugin-info-row">
            <span class="plugin-info-label">运行状态</span>
            <div>
              <span v-if="rt.runtimeOf(record.id).pid" class="mr-2">PID {{ rt.runtimeOf(record.id).pid }}</span>
              <span v-if="formatMem(rt.runtimeOf(record.id).memoryBytes)" class="mr-2">{{ formatMem(rt.runtimeOf(record.id).memoryBytes) }}</span>
              <span v-if="rt.runtimeOf(record.id).startedAt" class="mr-2">{{ durFrom(rt.runtimeOf(record.id).startedAt) }}</span>
              <span v-if="rt.runtimeOf(record.id).restarts > 0" class="mr-2">重启 {{ rt.runtimeOf(record.id).restarts }} 次</span>
              <span v-if="rt.runtimeOf(record.id).lastError" class="error-text">{{ rt.runtimeOf(record.id).lastError }}</span>
            </div>
          </div>

          <!-- 权限 -->
          <div class="plugin-info-row">
            <span class="plugin-info-label">权限</span>
            <span v-if="!record.grants.length" class="no-perms">无</span>
            <span
              v-else
              class="perm-count"
              @click.stop="showPermissions(record)"
            >{{ permPanel?.pluginId === record.id ? `${record.grants.length} 项已授予 ▲` : `${record.grants.length} 项已授予 →` }}</span>
          </div>

          <!-- 权限明细：内联展开在当前插件的「权限」行下方 -->
          <div v-if="permPanel && permPanel.pluginId === record.id" class="plugins-perm-panel" @click.stop>
            <div class="perm-panel-header">
              <h4>{{ permPanel.record.name }} — 权限</h4>
              <button class="btn-sm" @click="closePerms">关闭</button>
            </div>
            <div class="perm-panel-body">
              <p class="perm-summary">{{ summarizePermissions(permPanel.blocks.flatMap((b: any) => b.entries.map((e: any) => e.raw))) }}</p>
              <div class="perm-groups">
                <div v-for="block in permPanel.blocks" :key="block.group" class="perm-group">
                  <h5>{{ block.title }}</h5>
                  <div v-for="entry in block.entries" :key="entry.raw" class="perm-entry">
                    <span class="perm-entry-name">{{ entry.spec.title }}</span>
                    <span class="perm-entry-desc">{{ entry.spec.desc }}</span>
                    <span v-if="entry.scope" class="perm-entry-scope">范围：{{ entry.scope }}</span>
                    <button class="btn-tiny btn-warn" @click="revokePerm(permPanel.pluginId, entry.raw)">撤销</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 环境变量（宿主集中配置「设置 → 环境变量」，这里逐项授权） -->
          <div class="plugin-info-row">
            <span class="plugin-info-label">环境变量</span>
            <div @click.stop class="env-grant-cell">
              <div v-if="envNamesOf(record).length > 0" class="env-grant-chips">
                <span v-for="name in envNamesOf(record)" :key="name" class="env-grant-chip">
                  <code>{{ name }}</code>
                  <button class="btn-link" title="撤销该变量的授权" @click="revokeEnv(record, name)">撤销</button>
                </span>
              </div>
              <span v-else class="no-perms">未授权任何环境变量</span>
              <button class="btn-sm" @click="grantEnv(record)">选择变量…</button>
            </div>
          </div>

          <!-- 操作 -->
          <div class="plugin-detail-actions">
            <button class="btn-sm" @click.stop="showLog(record)">日志</button>
            <button
              class="btn-sm btn-warn"
              :disabled="uninstallingId === record.id"
              @click.stop="uninstallPlugin(record)"
            >{{ uninstallingId === record.id ? '卸载中…' : '卸载' }}</button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="cfg-card plugins-empty">
      <p v-if="filterMode === 'running'">没有插件在后台运行。</p>
      <p v-else-if="filterMode === 'error'">没有异常插件。</p>
      <p v-else>暂未安装插件。</p>
    </div>

    <!-- 已卸载的内置插件（可恢复） -->
    <div v-if="builtinEntries.filter(e => e.removed && e.available).length > 0" class="cfg-card plugins-list">
      <div class="cfg-card-head" @click="discardedExpanded = !discardedExpanded" style="cursor: pointer;">
        <h4>已丢弃的内置插件</h4>
        <span class="cfg-hint" style="margin-left: auto;">升级不会自动恢复，可手动重新安装</span>
        <span class="plugin-arrow" style="margin-left: 8px;">{{ discardedExpanded ? '▼' : '▶' }}</span>
      </div>
      <div v-if="discardedExpanded">
        <div
          v-for="entry in builtinEntries.filter(e => e.removed && e.available)"
          :key="entry.id"
          class="plugin-item"
        >
          <div class="plugin-header">
            <div class="plugin-icon"><span>🧩</span></div>
            <div class="plugin-meta">
              <div class="plugin-name">{{ entry.id }}<span class="tag-builtin">内置</span></div>
              <div class="plugin-desc">已被卸载，升级不会自动恢复</div>
            </div>
            <div class="plugin-state"></div>
            <div class="plugin-arrow"></div>
          </div>
          <div class="plugin-detail" style="display: block;">
            <div class="plugin-detail-actions">
              <button class="btn-sm" @click.stop="restoreBuiltin(entry.id)">重新安装</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 日志 -->
    <div v-if="logPanel" class="cfg-card plugins-log-panel">
      <div class="log-panel-header">
        <h4>日志</h4>
        <button class="btn-sm" @click="logPanel = null">关闭</button>
      </div>
      <pre class="log-content"><code>{{ logPanel.content }}</code></pre>
    </div>

    <!-- 环境变量授权选择器（宿主 UI） -->
    <EnvPicker
      :state="envPicker.state"
      :api="envPicker"
      @ok="envPicker.handleOk"
      @cancel="envPicker.handleCancel"
    />

    <!-- 插件安装确认弹窗（从文件安装 / 双击 .mspp 外部打开） -->
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
  </section>
</template>
