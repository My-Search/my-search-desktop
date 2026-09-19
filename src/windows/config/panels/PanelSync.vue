<script setup lang="ts">
/**
 * 备份与同步面板
 *
 * 顶部 tab：「导入 / 导出」。导出 = 本地保存备份文件，
 * 导入 = 选择归档文件 → 预览 → 还原。
 * 下方是 WebDAV 同步配置。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import {
  syncGetConfig,
  syncSetConfig,
  syncClearCredentials,
  syncTest,
  syncRemoteMeta,
  syncUpload,
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
import { collectState, restoreState } from "../../../lib/sync/snapshot.ts";
import { setOnStorageChange, storageGet } from "../../../lib/util.ts";
import { createSyncEngine, type SyncEngine, type SyncRunState } from "../../../lib/sync/engine.ts";

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
  } catch (e) { props.notify((e as Error)?.message ?? "保存配置失败", "error"); }
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
    const r = await backupRestore(inspectPath.value, cats);
    if (r.localStorage) restoreState(r.localStorage as Record<string, unknown>);
    const parts: string[] = [];
    if (r.plugins > 0) parts.push(`${r.plugins} 个插件`);
    if (r.settings) parts.push("设置");
    props.notify(`还原完成${parts.length ? `（${parts.join("、")}）` : ""}${r.snapshotPath ? "，已留底" : ""}`, "ok");
  } catch (e) { props.notify((e as Error)?.message ?? "还原失败", "error"); }
  finally { restoring.value = false; }
}

// ===================== WebDAV 同步 =====================
const testing = ref(false);
const syncState = ref<SyncRunState>({
  status: "idle", lastSyncAt: 0, lastError: "", remoteMeta: null,
  localFingerprint: "", settingsFingerprint: "",
});
let engine: SyncEngine | null = null;

async function doTest(): Promise<void> {
  testing.value = true;
  try {
    const cfg = await syncSetConfig(config.value, passwordInput.value || undefined);
    passwordInput.value = "";
    config.value = cfg;
    const r = await syncTest();
    props.notify(r.message, "ok");
  } catch (e) { props.notify((e as Error)?.message ?? String(e), "error"); }
  finally { testing.value = false; }
}
async function doClearPassword(): Promise<void> {
  if (!(await props.confirm("确定清空已保存的密码吗？"))) return;
  try { config.value = await syncClearCredentials(); props.notify("已清空密码", "ok"); }
  catch (e) { props.notify((e as Error)?.message ?? "清空失败", "error"); }
}
async function doSyncNow(): Promise<void> {
  try { await engine?.syncNow(); }
  catch (e) { props.notify((e as Error)?.message ?? "同步失败", "error"); }
}

function initEngine(): void {
  engine = createSyncEngine(
    config.value,
    () => storageGet("shortcut_bindings", []),
    () => true,
    (st) => { syncState.value = { ...st }; },
    async () => (await props.confirm("远端与本机都有改动：\n「确定」= 远端覆盖本机\n「取消」= 本机覆盖远端")) ? "remote" : "local"
  );
}
onMounted(async () => { await loadConfig(); initEngine(); if (config.value.enabled) { engine?.startBackground(); setOnStorageChange(() => engine?.onDataChanged()); } });
onBeforeUnmount(() => { engine?.stop(); setOnStorageChange(null); });
watch(() => [config.value.enabled, config.value.autoOnChange, config.value.intervalMinutes], () => engine?.reconfigure(config.value));

function fmt(ts: number): string {
  if (!ts) return "从未";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
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
    <p class="cfg-description">将当前的全部配置、插件与数据打包成一个 <code>.msbackup</code> 文件。</p>
    <div class="sync-actions-row">
      <button class="cfg-btn primary" :disabled="exporting" @click="doExport">
        {{ exporting ? '导出中…' : '保存到…' }}
      </button>
      <button class="cfg-btn" :disabled="exporting" @click="doExportToDir">
        {{ exporting ? '导出中…' : '导出到下载目录' }}
      </button>
      <button class="cfg-btn" @click="backupOpenDir">打开备份目录</button>
    </div>
    <div class="cfg-note" style="margin-top:10px">
      导出包含：订阅原文 / 标签偏好 / 权重与历史 / 插件注册表与文件 / 快捷键设置。
      不包含：GitHub Token、WebDAV 密码、本地数据缓存。
    </div>
  </div>

  <!-- ====== 导入面板 ====== -->
  <div v-if="tab === 'import'" class="cfg-card sync-tab-pane">
    <div class="cfg-card-head"><h3>从备份导入</h3></div>
    <p class="cfg-description">选择之前导出的 <code>.msbackup</code> 文件，预览内容后选择性还原。</p>

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
        <button class="cfg-btn" :disabled="restoring" @click="doRestore(['plugins', 'pluginData', 'settings'])">仅插件与设置</button>
        <button class="cfg-btn" :disabled="restoring" @click="doRestore(['localStorage', 'settings'])">仅配置</button>
      </div>
      <div class="cfg-note">还原前自动留底，误操作可在备份目录手动恢复。</div>
    </div>
  </div>

  <!-- ====== WebDAV 同步（独立卡片） ====== -->
  <div class="cfg-card">
    <div class="cfg-card-head">
      <h3>WebDAV 云端同步</h3>
      <span class="cfg-hint" :class="{ ok: syncState.status === 'idle', errorColor: syncState.status === 'error' }">
        <template v-if="syncState.status === 'idle' && config.enabled">上次同步：{{ fmt(syncState.lastSyncAt) }}</template>
        <template v-else-if="syncState.status === 'syncing' || syncState.status === 'uploading'">上传中…</template>
        <template v-else-if="syncState.status === 'downloading'">下载中…</template>
        <template v-else-if="syncState.status === 'error'">{{ syncState.lastError }}</template>
        <template v-else>—</template>
      </span>
    </div>

    <!-- 开关 -->
    <div class="sync-toggle-row">
      <label class="switch" :class="{ on: config.enabled, disabled: loadingConfig }">
        <input type="checkbox" v-model="config.enabled" :disabled="loadingConfig" />
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </label>
      <div class="sync-toggle-meta">
        <span class="sync-toggle-label">{{ config.enabled ? '已开启' : '已关闭' }}</span>
        <span class="sync-toggle-desc">数据变化自动同步，每 {{ config.intervalMinutes }} 分钟兜底检查</span>
      </div>
      <button v-if="config.enabled" class="cfg-btn primary sync-now-btn" :disabled="syncState.status !== 'idle'" @click="doSyncNow">立即同步</button>
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
        <label class="cfg-row-label">冲突策略</label>
        <select v-model="config.conflict" class="cfg-select">
          <option value="newer">按修改时间</option>
          <option value="local">本机覆盖远端</option>
          <option value="remote">远端覆盖本机</option>
          <option value="ask">每次询问</option>
        </select>
      </div>
      <div class="cfg-row">
        <label class="cfg-row-label">兜底间隔</label>
        <select v-model="config.intervalMinutes" class="cfg-select cfg-select-narrow">
          <option :value="5">5 分钟</option>
          <option :value="10">10 分钟</option>
          <option :value="15">15 分钟</option>
          <option :value="30">30 分钟</option>
          <option :value="60">60 分钟</option>
        </select>
      </div>

      <div class="sync-actions-row">
        <button class="cfg-btn" :disabled="testing" @click="doTest">{{ testing ? '测试中…' : '测试连接' }}</button>
        <button class="cfg-btn primary" @click="saveConfig">保存</button>
      </div>
    </template>

    <div v-if="!config.enabled" class="cfg-note" style="padding-top:6px">
      开启后数据变化会自动同步到 WebDAV 服务器，同时每 30 分钟兜底检查一次。
    </div>
  </div>
</section>
</template>