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
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { usePluginRuntime } from "../usePluginRuntime";
import {
  isKnownPermission,
  groupPermissions,
  summarizePermissions,
  requiresExplicitConsent,
  type PermissionGroupBlock,
} from "../../../lib/plugins/permissions";
import { type AutoStartMode, type BehaviorSuggestion, type CloseBehavior, behaviorSuggestionOf } from "../../../lib/plugins/registry";
import { readPluginBinary } from "../../../lib/plugins/ipc";
import { iconDataUrl, iconRefsOf, isInlineIconRef, primaryIconRef } from "../../../lib/plugins/icon";
import { markPluginFrontendRestart } from "../../../lib/plugins/restart";

const props = defineProps<{
  notify: (text: string, type?: "ok" | "error") => void;
  confirm: (text: string) => Promise<boolean>;
}>();

const rt = usePluginRuntime();

// ===================== 筛选 =====================
type FilterMode = "all" | "running" | "error";
const filterMode = ref<FilterMode>("all");
const showDev = ref(true);

const runningCount = computed(() => rt.runningCount());

/** 列表里的记录（真插件；历史遗留的 legacy 投影记录在挂载时已清理） */
const plugins = computed(() => rt.registry.plugins.filter((p: any) => p.source.kind !== "legacy"));

const displayList = computed(() => {
  const items: any[] = [];
  for (const rec of plugins.value) {
    if (!showDev.value && rec.source.dev) continue;
    const s = rt.runtimeOf(rec.id);
    if (filterMode.value === "running" && s.status !== "running" && s.status !== "starting") continue;
    if (filterMode.value === "error" && s.status !== "error" && s.status !== "crashed") continue;
    items.push(rec);
  }
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
  expanded.value[id] = !expanded.value[id];
}

// ===================== 行为设置（关闭界面时 / 开机自启） =====================
/**
 * 两个「插件声明默认值、用户可改」的开关。
 *
 * 共同规则（与 autostart 既有设计一致）：
 *   - 清单里写的只是**建议**，面板显示「插件建议：…」；
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

const autoStartLabel = (mode: AutoStartMode): string =>
  autoStartOptions.find((o) => o.value === mode)?.label ?? mode;
const closeBehaviorLabel = (mode: CloseBehavior): string =>
  closeBehaviorOptions.find((o) => o.value === mode)?.label ?? mode;

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

/** 恢复插件建议的默认值（两项一起，避免用户分不清恢复了哪个） */
async function restoreBehaviorDefaults(rec: any): Promise<void> {
  const s = suggestionOf(rec);
  const autoStartChanged = rec.autoStart !== s.autoStart;
  rec.autoStart = s.autoStart;
  rec.closeBehavior = s.closeBehavior;
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

async function uninstallPlugin(rec: any): Promise<void> {
  if (!(await props.confirm(`确定卸载「${rec.name}」v${rec.version}？`))) return;
  const deleteData = await props.confirm("是否同时删除插件保存的数据？");
  try {
    await rt.uninstall(rec.id, deleteData);
    // 清掉图标缓存里的残留键（重新安装时会再读一次）
    for (const k of Object.keys(iconMap.value)) {
      if (k.startsWith(`${rec.id}/`)) delete iconMap.value[k];
    }
    props.notify(`已卸载 ${rec.name}`, "ok");
  } catch (e) {
    props.notify(`卸载失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

// ===================== 安装 =====================
async function installFromFile(): Promise<void> {
  try {
    const { pickPluginPackage, readLocalFileBase64 } = await import("../../../lib/plugins/ipc");
    const { preparePackageFromBase64 } = await import("../../../lib/plugins/install");
    const path = await pickPluginPackage();
    if (!path) return;
    const b64 = await readLocalFileBase64(path);
    // 解包 + 剥离包裹目录 + 校验清单（纯逻辑，错误文案已面向用户）
    const prepared = await preparePackageFromBase64(b64, {
      hostVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
      checkPermissions: isKnownPermission,
    });
    const mf = prepared.manifest;

    const allPerms = [...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])];
    const consent = allPerms.filter(requiresExplicitConsent);
    const warnText = prepared.warnings.length > 0 ? `\n\n注意：\n· ${prepared.warnings.join("\n· ")}` : "";
    if (consent.length > 0) {
      const detail = groupPermissions(consent)
        .map((b) => `  ${b.title}: ${b.entries.map((e: any) => e.spec.title).join(", ")}`)
        .join("\n");
      if (
        !(await props.confirm(
          `插件「${mf.name}」请求敏感权限：\n${detail}\n\n${summarizePermissions(allPerms)}${warnText}\n\n是否继续安装？`
        ))
      ) {
        return;
      }
    } else {
      const summary = summarizePermissions(allPerms);
      if (!(await props.confirm(`安装「${mf.name}」v${mf.version}？\n${summary}${warnText}`))) return;
    }

    await rt.installFromFiles({
      manifest: mf,
      dir: `plugins/${mf.id}`,
      files: prepared.files,
      source: { kind: "file", ref: path },
      sha256: prepared.sha256,
      grants: allPerms,
    });
    props.notify(`已安装「${mf.name}」v${mf.version}`, "ok");
    await preloadIcons();
  } catch (e) {
    props.notify(`安装失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
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
    await preloadIcons();
  } catch (e) {
    props.notify(`挂载失败: ${String((e as Error)?.message ?? e)}`, "error");
  }
}

// ===================== 权限面板 =====================
const permPanel = ref<{ pluginId: string; blocks: PermissionGroupBlock[]; record: any } | null>(null);
function showPermissions(rec: any): void {
  const allPerms = [...(rec.manifest.permissions ?? []), ...(rec.manifest.optionalPermissions ?? [])];
  permPanel.value = { pluginId: rec.id, blocks: groupPermissions(allPerms.filter((p: string) => rec.grants.some((g: any) => g.permission === p))), record: rec };
}
function closePerms(): void {
  permPanel.value = null;
}
async function revokePerm(pluginId: string, permission: string): Promise<void> {
  rt.revoke(pluginId, permission);
  const rec = rt.get(pluginId);
  if (rec && permPanel.value?.pluginId === pluginId) showPermissions(rec);
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
  // 目录挂载插件的热重载：面板打开期间跟随源目录变化刷新展示
  void rt.startDevWatcher();
});

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
        <button class="btn-sm" @click="installFromFile()">从文件安装</button>
        <button class="btn-sm" @click="installDevDir()">从目录挂载</button>
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
            <div class="plugin-name">{{ record.name }}<span v-if="record.author" class="plugin-author"> · {{ record.author }}</span></div>
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
          <div class="plugin-info-row" v-if="record.homepage"><span class="plugin-info-label">主页</span><a :href="record.homepage" target="_blank">{{ record.homepage }}</a></div>

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
            <span v-else class="perm-count" @click.stop="showPermissions(record)">{{ record.grants.length }} 项已授予 →</span>
          </div>

          <!-- 操作 -->
          <div class="plugin-detail-actions">
            <button class="btn-sm" @click.stop="showLog(record)">日志</button>
            <button class="btn-sm btn-warn" @click.stop="uninstallPlugin(record)">卸载</button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="cfg-card plugins-empty">
      <p v-if="filterMode === 'running'">没有插件在后台运行。</p>
      <p v-else-if="filterMode === 'error'">没有异常插件。</p>
      <p v-else>暂未安装插件。</p>
    </div>

    <!-- 权限面板 -->
    <div v-if="permPanel" class="cfg-card plugins-perm-panel">
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

    <!-- 日志 -->
    <div v-if="logPanel" class="cfg-card plugins-log-panel">
      <div class="log-panel-header">
        <h4>日志</h4>
        <button class="btn-sm" @click="logPanel = null">关闭</button>
      </div>
      <pre class="log-content"><code>{{ logPanel.content }}</code></pre>
    </div>
  </section>
</template>
