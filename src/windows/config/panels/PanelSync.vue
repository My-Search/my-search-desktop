<script setup lang="ts">
/**
 * 备份与同步面板（**纯 UI**）
 *
 * 顶部 tab：「导入 / 导出」。导出 = 本地保存备份文件，导入 = 选择归档 →
 * 预览 → 还原。下方是 WebDAV 同步配置与状态。
 *
 * 同步执行者不在这里：面板随时可能被关闭，真正跑同步的是常驻主窗口的
 * SyncHost。本面板只做三件事：
 *   1. 读写配置；
 *   2. 发 `sync_request` / `sync_resolve_choice`；
 *   3. 订阅 `sync://status` 展示状态。
 *
 * 本地导入同样走 Rust 事务还原；写回 localStorage 后调用 `sync_commit_applied`，
 * 让主窗口统一重载插件（视图、独立窗口、后台进程）。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import CfgHint from "./CfgHint.vue";
import {
  syncGetConfig,
  syncSetConfig,
  syncClearCredentials,
  syncTest,
  syncRemoteMeta,
  syncRequest,
  syncResolveChoice,
  syncStateGet,
  syncCommitApplied,
  backupExportAs,
  backupExport,
  backupInspect,
  backupRestore,
  backupOpenDir,
  cloudManifestGet,
  cloudManifestV3Get,
  pickBackupFile,
  saveBackupPath,
  type SyncConfig,
  type BackupInspect,
  type SyncConflictShard,
} from "../../../lib/sync/bridge.ts";
import { collectState, pruneState, restoreState } from "../../../lib/sync/snapshot.ts";
import { notifySyncConfigChanged } from "../../../lib/tauri-bridge.ts";
import {
  cloudOverview,
  cloudPluginContents,
  ensurePluginData,
  type CloudOverview,
  type CloudPluginContent,
  type CloudPluginContentEntry,
} from "../../../lib/sync/cloud.ts";
import { loadRegistry } from "../../../lib/plugins/registry.ts";
import type { SyncRunState } from "../../../lib/sync/engine.ts";
import type { UnlistenFn } from "../../../lib/tauri-bridge.ts";

interface SyncPanelProps {
  notify: (text: string, type?: "ok" | "error") => void;
  confirm: (text: string) => Promise<boolean>;
}
const props = defineProps<SyncPanelProps>();

// ===================== Tab 切换 =====================
const tab = shallowRef<"export" | "import">("export");

// ===================== 同步配置 =====================
const config = ref<SyncConfig>({
  enabled: false,
  webdavUrl: "", webdavUser: "", remoteFile: "my-search-backup.msbackup",
  conflict: "newer", autoOnChange: true, intervalMinutes: 30, hasPassword: false,
});
const passwordInput = ref("");
const loadingConfig = ref(true);

async function loadConfig(): Promise<void> {
  loadingConfig.value = true;
  try { config.value = await syncGetConfig(); }
  catch (e) { console.warn("读取同步配置失败:", e); }
  finally { loadingConfig.value = false; }
}
async function saveConfig(): Promise<void> {
  try {
    config.value = await syncSetConfig(config.value, passwordInput.value || undefined);
    passwordInput.value = "";
    props.notify("同步配置已保存", "ok");
    void notifySyncConfigChanged();
    void refreshRemoteMeta();
    void loadCloudStats();
  } catch (e) { props.notify((e as Error)?.message ?? "保存配置失败", "error"); }
}

/** 开关切换即落盘并广播：不等用户点「保存」。关闭尤其要立刻生效——
 *  常驻主窗口收到广播立即停用自动同步；就算广播丢了，内核的 enabled 守卫
 *  也会拦住任何已排程的轮次。 */
async function onToggleEnabled(): Promise<void> {
  if (loadingConfig.value) return;
  try {
    config.value = await syncSetConfig(config.value, passwordInput.value || undefined);
    passwordInput.value = "";
    void notifySyncConfigChanged();
    if (config.value.enabled) void refreshRemoteMeta();
  } catch (e) { props.notify((e as Error)?.message ?? "保存开关状态失败", "error"); }
}

// ===================== 导出 =====================
const exporting = ref(false);
async function doExport(): Promise<void> {
  exporting.value = true;
  try {
    const path = await saveBackupPath();
    if (!path) return;
    const r = await backupExportAs(collectState(), path);
    props.notify(`导出成功（${(r.size / 1024).toFixed(1)} KB）`, "ok");
  } catch (e) { props.notify((e as Error)?.message ?? "导出失败", "error"); }
  finally { exporting.value = false; }
}
async function doExportToDir(): Promise<void> {
  exporting.value = true;
  try {
    await backupExport(collectState(), true);
    props.notify("已导出到「下载」目录与本地备份目录", "ok");
  } catch (e) { props.notify((e as Error)?.message ?? "导出失败", "error"); }
  finally { exporting.value = false; }
}

// ===================== 云端对象占用（v2 分片 / v3 文件级） =====================
/**
 * 各插件在**云端**的实际占用（manifest 里 body + data 的对象体积）与本机体积、
 * 配额剩余。用途：用户能直接看到「哪个插件占了多少、还有多少可用」，而不是只知道
 * 一个总大小；「下载数据」按钮就是懒加载的手动入口。
 */
const cloudOverviewData = ref<CloudOverview | null>(null);
const cloudLoading = ref(false);
const cloudDownloading = ref<string>("");
/** 插件 id → 显示名（loadCloudStats 时从插件注册表缓存读一次） */
const pluginNames = ref<Record<string, string>>({});

async function loadCloudStats(): Promise<void> {
  cloudLoading.value = true;
  try {
    cloudOverviewData.value = await cloudOverview();
    // 云端换了 manifest，之前展开的条目清单可能已过期
    contents.value = {};
    // 插件 id → 名字（插件注册表缓存，与插件面板同源；读一次别在模板里反复解析 JSON）
    const names: Record<string, string> = {};
    try {
      for (const rec of loadRegistry().plugins) {
        if (rec?.id && rec.name) names[rec.id] = rec.name;
      }
    } catch {
      /* 浏览器调试环境没有注册表 */
    }
    pluginNames.value = names;
  } catch {
    cloudOverviewData.value = null; // 浏览器调试 / IPC 抖动：不打断面板
  } finally {
    cloudLoading.value = false;
  }
}

/**
 * 云端插件 id → 显示名。云端可能存着**本机未安装**的插件（换设备登录就能装回来），
 * 这类只有 id，直接退回 id 展示，不编造名字。
 */
function pluginLabel(id: string): string {
  return pluginNames.value[id] ?? id;
}
// ---- 查看某插件云端具体内容（按需解析分片 ZIP，逐次点击触发） ----
const contentOpenId = ref("");
const contentLoadingId = ref("");
const contentError = ref("");
const contents = ref<Record<string, CloudPluginContent>>({});

async function togglePluginContents(id: string): Promise<void> {
  if (contentOpenId.value === id) {
    contentOpenId.value = "";
    return;
  }
  contentOpenId.value = id;
  if (contents.value[id]) return; // 已读过就用缓存，再次点击才刷新（见刷新按钮）
  await loadPluginContents(id);
}

async function loadPluginContents(id: string): Promise<void> {
  contentLoadingId.value = id;
  contentError.value = "";
  try {
    contents.value[id] = await cloudPluginContents(id);
  } catch (e) {
    contentError.value = (e as Error)?.message ?? "读取云端内容失败";
  } finally {
    contentLoadingId.value = "";
  }
}

interface ContentGroup {
  shard: "body" | "data";
  label: string;
  bytes: number;
  entries: CloudPluginContentEntry[];
}

/** 内容清单分组：body = 安装文件，data = kv / 云数据 store / 图片等 */
function contentGroups(c: CloudPluginContent): ContentGroup[] {
  const all: ContentGroup[] = [
    {
      shard: "body",
      label: "主体（程序文件）",
      bytes: c.bodyBytes,
      entries: c.entries.filter((e) => e.shard === "body"),
    },
    {
      shard: "data",
      label: "数据（kv / 云数据 store / 图片）",
      bytes: c.dataBytes,
      entries: c.entries.filter((e) => e.shard === "data"),
    },
  ];
  return all.filter((g) => g.entries.length > 0);
}

/** 手动拉取某个插件的数据分片（懒加载入口） */
async function downloadPluginData(id: string): Promise<void> {
  cloudDownloading.value = id;
  try {
    const r = await ensurePluginData(id);
    if (r.status === "applied") props.notify(`已下载 ${id} 的云端数据`, "ok");
    else if (r.status === "ready") props.notify(`${id} 的数据已是最新`, "ok");
    else if (r.status === "disabled") props.notify("云同步未启用", "error");
    else if (r.status === "conflict") props.notify(r.message ?? "本机与云端都有改动，请先选择冲突策略", "error");
    else if (r.status === "error") props.notify(r.message ?? "下载失败", "error");
    else props.notify("云端没有该插件的数据", "error");
    await loadCloudStats();
  } catch (e) {
    props.notify((e as Error)?.message ?? "下载失败", "error");
  } finally {
    cloudDownloading.value = "";
  }
}

// ===================== 导入 =====================
const importing = ref(false);
const inspectResult = ref<BackupInspect | null>(null);
const inspectPath = ref("");
async function doPickFile(): Promise<void> {
  importing.value = true; inspectResult.value = null; inspectPath.value = "";
  try {
    const file = await pickBackupFile();
    if (!file) return;
    inspectResult.value = await backupInspect(file);
    inspectPath.value = file;
  } catch (e) { props.notify((e as Error)?.message ?? "读取失败", "error"); }
  finally { importing.value = false; }
}

const restoring = ref(false);
async function doRestore(cats?: string[]): Promise<void> {
  if (!inspectPath.value) { props.notify("请先选择归档文件", "error"); return; }
  if (!(await props.confirm("还原将覆盖当前数据，是否继续？还原前会自动留底。"))) return;
  restoring.value = true;
  try {
    const r = await backupRestore(inspectPath.value, cats, collectState());
    const back = (r.localStorage ?? {}) as Record<string, unknown>;
    // 版本守卫：本机版本更高的插件不被降级；注册表记录同样保留本机
    const downgradeSkipped = r.downgradeSkipped ?? [];
    restoreState(back, { silent: true, keepLocalPluginIds: downgradeSkipped });
    // 全量还原时删除「远端没有、本机还留着」的键，否则用户的删除操作
    // 会在下一次同步时被本机重新带回去。范围还原只增不减。
    const isFull = !cats || cats.length === 0 || cats.includes("all");
    if (isFull) pruneState(back);
    // epoch + 广播：按 Rust 判定的实际范围决定重载插件视图/独立窗口/后台进程，
    // 只还原了配置时不会打断正在使用的插件。
    await syncCommitApplied("import", r.scope ?? "all");
    // 本地导入的数据同样需要同步到云端：立即请求一轮（否则要等 30 分钟兜底轮询）。
    // 未开启同步时静默跳过——导入本身仍然成功。
    if (config.value.enabled) void syncRequest("import");
    const parts: string[] = [];
    if (r.plugins > 0) parts.push(`${r.plugins} 个插件`);
    if (r.pluginData > 0) parts.push(`${r.pluginData} 个插件的私有数据`);
    if (downgradeSkipped.length > 0)
      parts.push(`已跳过 ${downgradeSkipped.length} 个本机版本更高的插件（未降级）`);
    if (r.settings) parts.push("设置");
    if (r.localStorageKeys > 0) parts.push(`${r.localStorageKeys} 项配置`);
    props.notify(`还原完成${parts.length ? `（${parts.join("、")}）` : ""}${r.snapshotPath ? "，已留底" : ""}`, "ok");
  } catch (e) { props.notify((e as Error)?.message ?? "还原失败", "error"); }
  finally { restoring.value = false; }
}

// ===================== WebDAV 同步 =====================
const testing = ref(false);
function emptyState(): SyncRunState {
  return {
    status: "idle", lastSyncAt: 0, lastError: "", remoteMeta: null,
    localDigest: "", initialized: false, remoteRev: "",
    needsChoice: false, choiceReason: "", conflicts: [], epoch: 1,
  };
}
const syncState = ref<SyncRunState>(emptyState());
/** 云端 manifest 的「最后提交设备」文案（展示用，失败为空） */
const lastDeviceText = ref("");
let unlistenStatus: UnlistenFn | null = null;

async function doTest(): Promise<void> {
  testing.value = true;
  try {
    const cfg = await syncSetConfig(config.value, passwordInput.value || undefined);
    passwordInput.value = "";
    config.value = cfg;
    const r = await syncTest();
    props.notify(r.message, "ok");
    void notifySyncConfigChanged();
    void refreshRemoteMeta();
  } catch (e) { props.notify((e as Error)?.message ?? String(e), "error"); }
  finally { testing.value = false; }
}
async function doClearPassword(): Promise<void> {
  if (!(await props.confirm("确定清空已保存的密码吗？"))) return;
  try { config.value = await syncClearCredentials(); props.notify("已清空密码", "ok"); }
  catch (e) { props.notify((e as Error)?.message ?? "清空失败", "error"); }
}

/** 立即同步：只发请求，执行与状态由主窗口 SyncHost 负责 */
async function doSyncNow(): Promise<void> {
  try { await syncRequest("manual"); }
  catch (e) { props.notify((e as Error)?.message ?? "同步请求失败", "error"); }
}

/** 首次连接 / 冲突：用户拍板后继续本轮同步。
 *
 * `pluginIds` 省略 = 全局；给定 = 只对这几个插件生效（`""` 是软件主体配置），
 * 其它插件的冲突继续挂起，本轮照常同步其余分片。 */
async function doChoose(choice: "local" | "remote", pluginIds?: string[]): Promise<void> {
  const scope = pluginIds
    ? `仅影响 ${pluginIds.map((id) => (id ? pluginLabel(id) : "软件主体")).join("、")}，其它插件不受影响`
    : "将影响全部插件";
  const text = choice === "remote"
    ? `「使用云端」会用远端备份覆盖本机数据（本机会自动留底）。${scope}，是否继续？`
    : `「保留本机」会用本机数据覆盖云端备份（不可撤销）。${scope}，是否继续？`;
  if (!(await props.confirm(text))) return;
  try { await syncResolveChoice(choice, pluginIds); }
  catch (e) { props.notify((e as Error)?.message ?? "提交选择失败", "error"); }
}

const syncBusy = computed(() =>
  syncState.value.status === "syncing" ||
  syncState.value.status === "uploading" ||
  syncState.value.status === "downloading"
);

const choiceTitle = computed(() =>
  syncState.value.choiceReason === "first-connect" ? "云端已有备份" : "有插件的数据两边都改了"
);
const choiceDesc = computed(() => {
  if (syncState.value.choiceReason === "first-connect") {
    const size = syncState.value.remoteMeta?.size;
    const sizeText = size ? `（${fmtSize(size)}）` : "";
    return `本机尚未与这份云端备份建立同步关系${sizeText}。请选择以哪一份为准：`;
  }
  if (conflictGroups.value.length) {
    return "下面这几片两边都改过，为避免互相覆盖请各自拍板；没列出来的插件已经正常同步完成，不受影响。";
  }
  return "云端与本机都发生了变化。为避免互相覆盖，请选择保留哪一份：";
});

/** 冲突明细按**插件**归并：同一插件的程序/数据片一起裁决，一行一次决定 */
interface ConflictGroup {
  pluginId: string;
  kinds: SyncConflictShard["kind"][];
  localBytes: number;
  remoteBytes: number;
  remoteUpdatedAt: number;
}
const conflictGroups = computed<ConflictGroup[]>(() => {
  const map = new Map<string, ConflictGroup>();
  for (const c of syncState.value.conflicts) {
    const g = map.get(c.pluginId) ?? { pluginId: c.pluginId, kinds: [], localBytes: 0, remoteBytes: 0, remoteUpdatedAt: 0 };
    if (!g.kinds.includes(c.kind)) g.kinds.push(c.kind);
    g.localBytes += c.localBytes || 0;
    g.remoteBytes += c.remoteBytes || 0;
    g.remoteUpdatedAt = Math.max(g.remoteUpdatedAt, c.remoteUpdatedAt || 0);
    map.set(c.pluginId, g);
  }
  return [...map.values()].sort((a, b) => (a.pluginId === "" ? -1 : b.pluginId === "" ? 1 : a.pluginId.localeCompare(b.pluginId)));
});

/** 云端备份大小（HEAD 拿到的 Content-Length），随同步轮次自动更新 */
const remoteSizeText = computed<string>(() => {
  const meta = syncState.value.remoteMeta;
  if (!meta?.exists || !meta.size) return "";
  return fmtSize(meta.size);
});

/** 覆盖前留底的文件名（路径可能很长，面板只展示文件名） */
const backupFileName = computed<string>(() => {
  const path = syncState.value.lastLocalBackupPath ?? "";
  return path.split(/[\\/]/).pop() || path;
});

/** 主动拉一次云端元信息，填充「云端备份」大小。失败静默：只是辅助信息，
 *  不该在面板加载/保存时弹错误打扰用户（真正的连接错误由测试连接/同步上报）。 */
async function refreshRemoteMeta(): Promise<void> {
  if (!config.value.enabled) return;
  try {
    const meta = await syncRemoteMeta();
    if (meta.exists) syncState.value = { ...syncState.value, remoteMeta: meta };
  } catch { /* 静默 */ }
  try {
    const v3 = await cloudManifestV3Get().catch(() => ({ exists: false, manifest: null }) as const);
    const man = v3.manifest ?? (await cloudManifestGet()).manifest;
    if (!man) {
      lastDeviceText.value = "";
      return;
    }
    const id = man.updatedBy || "";
    const device = man.devices?.[id];
    const name = device?.name || (id ? `设备 ${id.slice(0, 8)}` : "");
    const at = man.updatedAt ? `，${fmtTime(man.updatedAt)}` : "";
    const format = v3.exists ? "v3 文件级" : "v2 分片";
    lastDeviceText.value = name ? `最后提交：${name}${at}（${format}）` : "";
  } catch { /* 旧服务端 / 无 manifest 时静默 */ }
}

async function loadPersistedState(): Promise<void> {
  try {
    const s = await syncStateGet();
    if (syncState.value.status !== "idle") return; // 已收到实时状态，别覆盖
    // 上轮遗留的冲突（主窗口重启后仍要提示）：只挂起这几片，其余片早已同步完成
    const conflicts = s.conflicts ?? [];
    syncState.value = {
      ...emptyState(),
      lastSyncAt: s.lastSyncAt,
      initialized: s.initialized,
      remoteRev: s.remoteRev,
      localDigest: s.lastLocalDigest,
      epoch: s.epoch,
      needsChoice: conflicts.length > 0,
      choiceReason: conflicts.length > 0 ? "conflict" : "",
      conflicts,
    };
  } catch { /* 浏览器调试 / 首次运行 */ }
}

async function subscribeStatus(): Promise<void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlistenStatus = await listen<SyncRunState>("sync://status", (e) => {
      if (e.payload) syncState.value = { ...e.payload };
    });
  } catch { /* 事件总线不可用 */ }
}

onMounted(async () => {
  await loadConfig();
  await loadPersistedState();
  await subscribeStatus();
  void loadCloudStats();
  if (config.value.enabled) {
    // 只读快照：主窗口若正停在 needs-choice，重开面板也能继续做选择。
    void syncRequest("status");
    void refreshRemoteMeta();
  }
});
onBeforeUnmount(() => {
  unlistenStatus?.();
  unlistenStatus = null;
});

function fmt(ts: number): string {
  if (!ts) return "从未";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fmtSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 冲突明里的时间：同一天只显示时分，隔天带日期 */
function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 冲突片的类型名（插件级隔离下用户只需知道「哪一部分」） */
function kindLabel(kind: SyncConflictShard["kind"]): string {
  return kind === "core" ? "软件主体" : kind === "body" ? "插件程序" : "插件数据";
}

/** 供设置窗口在「同步/导入已应用」后刷新（defineExpose 父组件 ref 才能调到） */
async function refreshAfterRestore(): Promise<void> {
  await loadConfig();
  await loadPersistedState();
  if (config.value.enabled) void refreshRemoteMeta();
}
defineExpose({ refreshAfterRestore });
</script>

<template>
<section class="page sync">

  <!-- ====== Tab 栏 ====== -->
  <div class="sync-tabs">
    <button class="sync-tab" :class="{ on: tab === 'export' }" @click="tab = 'export'">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l-5 8h4v5h2V9h4L10 1z"/></svg>
      导出
    </button>
    <button class="sync-tab" :class="{ on: tab === 'import' }" @click="tab = 'import'">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10 19l5-8h-4V6H9v5H5l5 8z"/></svg>
      导入
    </button>
  </div>

  <!-- ====== 导出面板 ====== -->
  <div v-if="tab === 'export'" class="cfg-card sync-tab-pane">
    <div class="cfg-card-head"><h3>导出备份</h3></div>
    <div class="sync-actions-row">
      <button class="cfg-btn primary" :disabled="exporting" @click="doExport">
        {{ exporting ? '导出中…' : '保存到…' }}
      </button>
      <button class="cfg-btn" :disabled="exporting" @click="doExportToDir">
        {{ exporting ? '导出中…' : '导出到下载目录' }}
      </button>
      <button class="cfg-btn" @click="backupOpenDir">打开备份目录</button>
    </div>
  </div>

  <!-- ====== 导入面板 ====== -->
  <div v-if="tab === 'import'" class="cfg-card sync-tab-pane">
    <div class="cfg-card-head"><h3>从备份导入</h3></div>

    <!-- 文件选择 -->
    <div class="sync-actions-row">
      <button class="cfg-btn primary" :disabled="importing" @click="doPickFile">
        {{ importing ? '读取中…' : '选择备份文件…' }}
      </button>
    </div>

    <!-- 预览 -->
    <div v-if="inspectResult" class="inspect-panel">
      <div class="inspect-header">
        <strong>备份内容</strong>
        <span class="cfg-hint">{{ inspectResult.exportedAt ? new Date(inspectResult.exportedAt).toLocaleString() : '' }}</span>
      </div>
      <div class="inspect-tags">
        <span class="inspect-tag">v{{ inspectResult.appVersion || '?' }}</span>
        <span class="inspect-tag">{{ (inspectResult.totalBytes / 1024).toFixed(1) }} KB</span>
        <span class="inspect-tag">{{ inspectResult.localStorageKeys }} 项配置</span>
        <span v-if="inspectResult.pluginIds.length" class="inspect-tag">{{ inspectResult.pluginIds.length }} 个插件</span>
        <span v-if="inspectResult.pluginDataFiles" class="inspect-tag">{{ inspectResult.pluginDataFiles }} 个数据文件</span>
        <span v-if="inspectResult.syncStoreFiles" class="inspect-tag">{{ inspectResult.syncStoreFiles }} 个云数据文件</span>
        <span v-if="inspectResult.hasSettings" class="inspect-tag">含设置</span>
      </div>

      <div class="inspect-actions">
        <button class="cfg-btn primary" :disabled="restoring" @click="doRestore()">
          {{ restoring ? '还原中…' : '全量还原' }}
        </button>
        <button class="cfg-btn" :disabled="restoring" @click="doRestore(['plugins'])">仅插件与数据</button>
        <button class="cfg-btn" :disabled="restoring" @click="doRestore(['config'])">仅配置</button>
      </div>
    </div>
  </div>

  <!-- ====== WebDAV 同步（独立卡片） ====== -->
  <div class="cfg-card">
    <div class="cfg-card-head">
      <h3>WebDAV 云端同步</h3>
      <span class="cfg-hint" :class="{ ok: syncState.status === 'idle' && config.enabled, errorColor: syncState.status === 'error' }">
        <template v-if="syncState.status === 'idle' && config.enabled">上次同步：{{ fmt(syncState.lastSyncAt) }}</template>
        <template v-else-if="syncState.status === 'syncing'">检查云端…</template>
        <template v-else-if="syncState.status === 'uploading'">上传中…</template>
        <template v-else-if="syncState.status === 'downloading'">下载中…</template>
        <template v-else-if="syncState.status === 'needs-choice'">等待选择</template>
        <template v-else-if="syncState.status === 'error'">{{ syncState.lastError }}</template>
      </span>
    </div>

    <!-- 开关 -->
    <div class="sync-toggle-row">
      <label class="switch" :class="{ on: config.enabled, disabled: loadingConfig }">
        <input type="checkbox" v-model="config.enabled" :disabled="loadingConfig" @change="onToggleEnabled" />
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </label>
      <div class="sync-toggle-meta">
        <span class="sync-toggle-label">{{ config.enabled ? '已开启' : '已关闭' }}</span>
        <span class="sync-toggle-desc">数据变化自动同步，每 {{ config.intervalMinutes }} 分钟兜底检查</span>
        <span class="sync-toggle-desc">窗口尺寸、最近附件、开机自启等设备专属设置只留本机</span>
        <span v-if="syncState.lastError && syncState.status !== 'error'" class="sync-toggle-desc errorColor">{{ syncState.lastError }}</span>
        <span v-if="remoteSizeText" class="sync-toggle-desc sync-remote-size">云端备份：{{ remoteSizeText }}</span>
        <span v-if="lastDeviceText" class="sync-toggle-desc">{{ lastDeviceText }}</span>
      </div>
      <!-- 有冲突也允许立即同步：冲突片挂起，其它插件照常推拉 -->
      <button v-if="config.enabled" class="cfg-btn primary sync-now-btn" :disabled="syncBusy" @click="doSyncNow">
        {{ syncBusy ? '同步中…' : '立即同步' }}
      </button>
    </div>

    <!-- 首次连接 / 冲突：必须由用户决定方向，绝不自动覆盖 -->
    <div v-if="config.enabled && syncState.needsChoice" class="sync-choice">
      <div class="sync-choice-title">{{ choiceTitle }}</div>
      <div class="sync-choice-desc">{{ choiceDesc }}</div>

      <!-- 冲突按插件隔离：只挂起这几片，其它插件/其它片本轮已照常同步 -->
      <div v-if="conflictGroups.length" class="sync-conflict-list">
        <div v-for="g in conflictGroups" :key="g.pluginId || 'core'" class="sync-conflict-row">
          <div class="sync-conflict-main">
            <div class="sync-conflict-name">{{ g.pluginId ? pluginLabel(g.pluginId) : '软件主体（设置与界面配置）' }}</div>
            <div class="sync-conflict-meta">
              <span class="sync-conflict-kind">{{ g.kinds.map(kindLabel).join('/') }}</span>
              <span>本机 {{ fmtSize(g.localBytes) }}</span>
              <span>云端 {{ fmtSize(g.remoteBytes) }}</span>
              <span v-if="g.remoteUpdatedAt">云端更新于 {{ fmtTime(g.remoteUpdatedAt) }}</span>
            </div>
          </div>
          <div class="sync-conflict-actions">
            <button class="cfg-btn" @click="doChoose('remote', [g.pluginId])">用云端</button>
            <button class="cfg-btn primary" @click="doChoose('local', [g.pluginId])">用本机</button>
          </div>
        </div>
      </div>

      <div class="sync-actions-row">
        <template v-if="conflictGroups.length">
          <button class="cfg-btn primary" @click="doChoose('remote')">全部用云端</button>
          <button class="cfg-btn" @click="doChoose('local')">全部用本机</button>
        </template>
        <template v-else>
          <button class="cfg-btn primary" @click="doChoose('remote')">使用云端</button>
          <button class="cfg-btn" @click="doChoose('local')">保留本机</button>
        </template>
      </div>
    </div>

    <!-- 覆盖前的本机快照：即使误点「用云端」，也能从备份目录找回 -->
    <div v-if="syncState.lastLocalBackupPath" class="sync-backup-note">
      <span class="sync-backup-note-text">覆盖前的本机快照：{{ backupFileName }}</span>
      <button class="cfg-btn" @click="backupOpenDir">打开备份目录</button>
    </div>

    <!-- 连接配置 -->
    <template v-if="config.enabled">
      <div class="cfg-row">
        <label class="cfg-row-label">WebDAV 地址</label>
        <input class="cfg-input" type="url" v-model="config.webdavUrl" placeholder="https://dav.jianguoyun.com/dav/" />
      </div>
      <div class="cfg-row">
        <label class="cfg-row-label">用户名</label>
        <input class="cfg-input" type="text" v-model="config.webdavUser" placeholder="WebDAV 授权用户名" />
      </div>
      <div class="cfg-row">
        <label class="cfg-row-label">密码</label>
        <div class="cfg-row-value">
          <input class="cfg-input" type="password" v-model="passwordInput" :placeholder="config.hasPassword ? '已设置，不改请留空' : '密码或应用专用密码'" />
          <button v-if="config.hasPassword" class="cfg-btn btn-warn" @click="doClearPassword">清空</button>
        </div>
      </div>
      <div class="cfg-row">
        <label class="cfg-row-label">远端文件名</label>
        <input class="cfg-input" type="text" v-model="config.remoteFile" placeholder="my-search-backup.msbackup" />
      </div>
      <div class="cfg-row">
        <label class="cfg-row-label">冲突策略<CfgHint text="当远端与本机都有改动时，按所选策略决定保留哪份数据。首次连接云端已有备份时始终会先询问。" /></label>
        <div class="cfg-select-wrap">
          <select v-model="config.conflict" class="cfg-select">
            <option value="newer">按修改时间</option>
            <option value="local">本机覆盖远端</option>
            <option value="remote">远端覆盖本机</option>
            <option value="ask">每次询问</option>
          </select>
        </div>
      </div>
      <div class="cfg-row">
        <label class="cfg-row-label">兜底间隔<CfgHint text="即使数据无变化，也会按此间隔主动检查一次远端，防止漏同步。" /></label>
        <div class="cfg-select-wrap cfg-select-narrow">
          <select v-model="config.intervalMinutes" class="cfg-select">
            <option :value="5">5 分钟</option>
            <option :value="10">10 分钟</option>
            <option :value="15">15 分钟</option>
            <option :value="30">30 分钟</option>
            <option :value="60">60 分钟</option>
          </select>
        </div>
      </div>

      <div class="sync-actions-row">
        <button class="cfg-btn" :disabled="testing" @click="doTest">{{ testing ? '测试中…' : '测试连接' }}</button>
        <button class="cfg-btn primary" @click="saveConfig">保存</button>
      </div>
    </template>
  </div>

  <!-- ====== 云端对象（紧随 WebDAV 配置：按插件看云端占用 / 配额 / 具体内容） ====== -->
  <div class="cfg-card">
    <div class="cfg-card-head">
      <h3>云端对象</h3>
      <CfgHint
        text="v3 用 manifest-v3.json 作唯一提交点：core / 插件程序仍按摘要对象存放，插件数据拆成每文件对象，≤2KB 的文本内联，图片走内容寻址 blob。只传变了的文件；剪贴板只同步收藏/分类条目及其引用图片，普通历史留本机。旧 manifest.json 保持只读，回滚只需删掉 v3 提交点。单插件云端配额 200MB。「查看内容」直接列 manifest 里的文件/图片清单，不下载分片，只读。"
      />
      <button class="cfg-btn ghost sync-cloud-refresh" :disabled="cloudLoading" @click="loadCloudStats">
        {{ cloudLoading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <p v-if="!config.enabled" class="cfg-hint">云同步未开启。开启并完成一轮同步后，这里会按插件列出云端占用。</p>
    <template v-else-if="cloudOverviewData">
      <p class="cfg-hint">
        云端合计 {{ fmtSize(cloudOverviewData.totalBytes) }} · 单插件配额 {{ fmtSize(cloudOverviewData.quotaBytes) }}
        <span v-if="cloudOverviewData.format === 3"> · v3 文件级</span>
        <span v-if="cloudOverviewData.manifestExists">
          · rev {{ cloudOverviewData.rev }} · 最近提交 {{ fmt(cloudOverviewData.updatedAt) }}
        </span>
        <span v-if="cloudOverviewData.pendingCount">
          · {{ cloudOverviewData.pendingCount }} 个插件的数据待下载
        </span>
      </p>
      <div v-if="cloudOverviewData.plugins.length" class="sync-cloud-list">
        <div class="sync-cloud-row sync-cloud-head">
          <span class="sync-cloud-id">插件</span>
          <span class="sync-cloud-size">云端占用</span>
          <span class="sync-cloud-local">本机占用</span>
          <span class="sync-cloud-quota">配额剩余</span>
          <span class="sync-cloud-status">状态</span>
          <span class="sync-cloud-actions">操作</span>
        </div>
        <template v-for="p in cloudOverviewData.plugins" :key="p.id">
          <div class="sync-cloud-row">
            <span class="sync-cloud-id" :title="p.id">
              <strong
                class="sync-cloud-name"
                :class="{ 'as-id': pluginLabel(p.id) === p.id }"
              >{{ pluginLabel(p.id) }}</strong>
              <em v-if="pluginLabel(p.id) !== p.id" class="sync-cloud-pid">{{ p.id }}</em>
            </span>
            <span class="sync-cloud-size">{{ fmtSize(p.cloudBytes) }}</span>
            <span class="sync-cloud-local">{{ fmtSize(p.localBytes) }}</span>
            <span class="sync-cloud-quota">{{ fmtSize(p.remainingBytes) }}</span>
            <span class="sync-cloud-status" :class="{ pending: p.pendingData }">
              <span class="sync-cloud-status-main">{{ p.pendingData ? '数据待下载' : '已同步' }}</span>
              <span v-if="!p.pendingData && cloudOverviewData.format === 3" class="sync-cloud-status-sub">
                {{ p.fileCount ?? 0 }} 文件<template v-if="p.blobCount"> / {{ p.blobCount }} 图片</template>
              </span>
            </span>
            <span class="sync-cloud-actions">
              <button class="cfg-btn ghost" @click="togglePluginContents(p.id)">
                {{ contentOpenId === p.id ? '收起' : '查看内容' }}
              </button>
              <button
                v-if="p.pendingData"
                class="cfg-btn ghost"
                :disabled="cloudDownloading === p.id"
                @click="downloadPluginData(p.id)"
              >
                {{ cloudDownloading === p.id ? '下载中…' : '下载数据' }}
              </button>
            </span>
          </div>

          <!-- 该插件云端具体内容（按需解析分片清单） -->
          <div v-if="contentOpenId === p.id" class="sync-cloud-detail">
            <div v-if="contentLoadingId === p.id" class="cfg-hint">正在读取云端对象…</div>
            <p v-else-if="contentError" class="cfg-hint errorColor">{{ contentError }}</p>
            <template v-else-if="contents[p.id]">
              <p v-if="!contents[p.id].entries.length" class="cfg-hint">
                云端没有该插件的内容（可能只存在于本机，尚未同步）。
              </p>
              <template v-else>
                <div v-for="g in contentGroups(contents[p.id])" :key="g.shard" class="sync-cloud-group">
                  <div class="sync-cloud-group-head">
                    <span>{{ g.label }}</span>
                    <span class="cfg-hint">{{ g.entries.length }} 项 · {{ fmtSize(g.bytes) }}</span>
                  </div>
                  <div v-for="e in g.entries" :key="g.shard + ':' + e.name" class="sync-cloud-entry">
                    <span class="sync-cloud-entry-name" :title="e.name">{{ e.name }}</span>
                    <span class="sync-cloud-entry-size">{{ fmtSize(e.size) }}</span>
                  </div>
                  <p v-if="contents[p.id].truncated" class="cfg-hint">条目过多，仅列出前 2000 项。</p>
                </div>
                <div class="sync-cloud-detail-foot">
                  <span class="cfg-hint">合计 {{ fmtSize(contents[p.id].totalBytes) }}</span>
                  <button class="cfg-btn ghost" :disabled="contentLoadingId === p.id" @click="loadPluginContents(p.id)">
                    重新读取
                  </button>
                </div>
              </template>
            </template>
          </div>
        </template>
      </div>
      <p v-else class="cfg-hint">
        云端还没有任何分片。开启同步并完成一轮后，这里会列出每个插件的云端占用。
      </p>
    </template>
    <p v-else class="cfg-hint">云端占用暂不可读（未启用同步 / 浏览器调试环境 / 桌面端未就绪）。</p>
  </div>
</section>
</template>
