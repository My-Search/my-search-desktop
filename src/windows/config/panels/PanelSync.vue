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
  pickBackupFile,
  saveBackupPath,
  type SyncConfig,
  type BackupInspect,
} from "../../../lib/sync/bridge.ts";
import { collectState, pruneState, restoreState } from "../../../lib/sync/snapshot.ts";
import { notifySyncConfigChanged } from "../../../lib/tauri-bridge.ts";
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
    needsChoice: false, choiceReason: "", epoch: 1,
  };
}
const syncState = ref<SyncRunState>(emptyState());
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

/** 首次连接 / 冲突：用户拍板后继续本轮同步 */
async function doChoose(choice: "local" | "remote"): Promise<void> {
  const text = choice === "remote"
    ? "「使用云端」会用远端备份覆盖本机数据（本机会自动留底），是否继续？"
    : "「保留本机」会用本机数据覆盖云端备份（不可撤销），是否继续？";
  if (!(await props.confirm(text))) return;
  try { await syncResolveChoice(choice); }
  catch (e) { props.notify((e as Error)?.message ?? "提交选择失败", "error"); }
}

const syncBusy = computed(() =>
  syncState.value.status === "syncing" ||
  syncState.value.status === "uploading" ||
  syncState.value.status === "downloading"
);

const choiceTitle = computed(() =>
  syncState.value.choiceReason === "first-connect" ? "云端已有备份" : "云端与本机都有改动"
);
const choiceDesc = computed(() => {
  const size = syncState.value.remoteMeta?.size;
  const sizeText = size ? `（${fmtSize(size)}）` : "";
  return syncState.value.choiceReason === "first-connect"
    ? `本机尚未与这份云端备份建立同步关系${sizeText}。请选择以哪一份为准：`
    : `云端备份${sizeText}与本机都发生了变化。为避免互相覆盖，请选择保留哪一份：`;
});

/** 云端备份大小（HEAD 拿到的 Content-Length），随同步轮次自动更新 */
const remoteSizeText = computed<string>(() => {
  const meta = syncState.value.remoteMeta;
  if (!meta?.exists || !meta.size) return "";
  return fmtSize(meta.size);
});

/** 主动拉一次云端元信息，填充「云端备份」大小。失败静默：只是辅助信息，
 *  不该在面板加载/保存时弹错误打扰用户（真正的连接错误由测试连接/同步上报）。 */
async function refreshRemoteMeta(): Promise<void> {
  if (!config.value.enabled) return;
  try {
    const meta = await syncRemoteMeta();
    if (meta.exists) syncState.value = { ...syncState.value, remoteMeta: meta };
  } catch { /* 静默 */ }
}

async function loadPersistedState(): Promise<void> {
  try {
    const s = await syncStateGet();
    if (syncState.value.status !== "idle") return; // 已收到实时状态，别覆盖
    syncState.value = {
      ...emptyState(),
      lastSyncAt: s.lastSyncAt,
      initialized: s.initialized,
      remoteRev: s.remoteRev,
      localDigest: s.lastLocalDigest,
      epoch: s.epoch,
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
        <span v-if="remoteSizeText" class="sync-toggle-desc sync-remote-size">云端备份：{{ remoteSizeText }}</span>
      </div>
      <button v-if="config.enabled" class="cfg-btn primary sync-now-btn" :disabled="syncBusy || syncState.needsChoice" @click="doSyncNow">
        {{ syncBusy ? '同步中…' : '立即同步' }}
      </button>
    </div>

    <!-- 首次连接 / 冲突：必须由用户决定方向，绝不自动覆盖 -->
    <div v-if="config.enabled && syncState.needsChoice" class="sync-choice">
      <div class="sync-choice-title">{{ choiceTitle }}</div>
      <div class="sync-choice-desc">{{ choiceDesc }}</div>
      <div class="sync-actions-row">
        <button class="cfg-btn primary" @click="doChoose('remote')">使用云端</button>
        <button class="cfg-btn" @click="doChoose('local')">保留本机</button>
      </div>
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
</section>
</template>
