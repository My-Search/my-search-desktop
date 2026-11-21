<script setup lang="ts">
/**
 * 插件安装确认弹窗 —— 搜索框 .mspp chip 点击 / 设置窗口安装共用。
 *
 * 与 MessageDialog 的区别：本弹窗展示富内容（logo、权限分组列表、警告），
 * 而非纯文本。保持与 MessageDialog 同款的遮罩/卡片风格。
 *
 * 确认按钮文案随安装态变化：未安装「安装」/ 同版本「重新安装」/ 高版本「升级」。
 */
import { computed, nextTick, ref, watch } from "vue";
import { compareVersion, type PluginManifest } from "../lib/plugins/manifest.ts";
import { syncPermissionRequested, type PermissionGroupBlock } from "../lib/plugins/permissions.ts";

const props = defineProps<{
  visible: boolean;
  manifest: PluginManifest | null;
  iconUrl: string | null;
  permBlocks: PermissionGroupBlock[];
  warnings: string[];
  /** 已安装的版本（null / undefined = 未安装过该插件） */
  installedVersion?: string | null;
  /** 该插件当前是否在后台运行（升级时据此提示「将先停止再安装」） */
  running?: boolean;
  /** 是否在弹窗中展示「自动更新此插件」开关（默认展示；仅特殊无需自动更新场景传 false 隐藏） */
  showAutoUpdate?: boolean;
  /** 「自动更新此插件」开关当前状态 */
  autoUpdate?: boolean;
  /**
   * 本次升级的更新日志（可多行）。
   *
   * 市场更新优先传目录条目里「本版本」的 changelog；文件安装不传时
   * 组件回退到清单的 `changelog`。仅升级时展示，全新安装不展示。
   */
  changelog?: string | null;
}>();

const emit = defineEmits<{
  (e: "confirm"): void;
  (e: "cancel"): void;
  (e: "update:autoUpdate", value: boolean): void;
}>();

const okBtn = ref<HTMLButtonElement | null>(null);

watch(
  () => props.visible,
  (v) => {
    // 只把焦点移到「安装」按钮（便于回车确认），但不滚动——否则权限多的插件
    // 弹窗内容超过 max-height 时，聚焦底部按钮会把弹窗滚到最底部，一打开只见底部。
    if (v) nextTick(() => okBtn.value?.focus({ preventScroll: true }));
  }
);

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit("cancel");
}

const hasContent = computed(() => props.manifest != null);

/**
 * 该插件是否申请了「数据同步」权限。
 *
 * 用于渲染下方的**数据同步提醒**：同步的对象是用户自己的云端备份（整份可备份
 * 数据），波及范围远超「插件自己那一小块数据」，因此要在装之前单独讲清楚，
 * 不能只淹没在权限清单的一条里（清单只写「触发数据同步」，读不出范围）。
 */
const requestsSync = computed(() => {
  const mf = props.manifest;
  if (!mf) return false;
  return syncPermissionRequested([...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])]);
});

/**
 * 确认按钮文案：未安装 → 安装；同版本 → 重新安装；包版本更高 → 升级。
 * （降级仍显示「安装」——落盘时 planUpgrade 会拒绝并给出明确提示。）
 */
const confirmLabel = computed(() => {
  const mf = props.manifest;
  if (!mf || !props.installedVersion) return "安装";
  const cmp = compareVersion(mf.version, props.installedVersion);
  if (cmp === 0) return "重新安装";
  if (cmp > 0) return "升级";
  return "安装";
});

/**
 * 是否展示「将强制停止正在运行的进程」提示。
 *
 * 覆盖安装（同版本重装 / 升级）时，Rust 侧必须先停掉该插件的后台进程，
 * 否则 Windows 上运行中的程序占着文件句柄、替换目录会失败。这个副作用要提前
 * 告诉用户，避免他看到「更新中 → 进程被重启」时以为出了问题。
 */
const showForceStopNotice = computed(
  () => !!props.installedVersion && props.running === true
);

/**
 * 是否为「升级」（新版本 > 已安装版本）。
 *
 * 更新日志只在升级时展示：全新安装看到的是插件历史日志、同版本重装看到的
 * 是当前版本说明，都不是用户所说的「本次更新的日志」。
 */
const isUpgrade = computed(() => {
  const mf = props.manifest;
  if (!mf || !props.installedVersion) return false;
  return compareVersion(mf.version, props.installedVersion) > 0;
});

/** 本次升级的更新日志正文（市场目录优先，缺省回退清单；空串 = 不展示） */
const changelogText = computed(() => {
  if (!isUpgrade.value) return "";
  return (props.changelog ?? props.manifest?.changelog ?? "").trim();
});
</script>

<template>
  <div
    v-if="visible"
    class="plugin-install-overlay"
    @click="onOverlayClick"
  >
    <div class="plugin-install-dialog">
      <!-- 标题 -->
      <div class="plugin-install-title">插件安装</div>
      <!-- 头部：logo + 基本信息 -->
      <div class="plugin-install-header">
        <img
          v-if="iconUrl"
          class="plugin-install-logo"
          :src="iconUrl"
          alt=""
        />
        <div v-else class="plugin-install-logo-placeholder">🧩</div>
        <div class="plugin-install-meta">
          <h3 class="plugin-install-name">
            {{ manifest?.name ?? "未知插件" }}
          </h3>
          <p class="plugin-install-version">
            v{{ manifest?.version ?? "?" }}
            <span v-if="manifest?.author" class="plugin-install-author">
              · {{ manifest.author }}
            </span>
          </p>
          <p v-if="manifest?.description" class="plugin-install-desc">
            {{ manifest.description }}
          </p>
        </div>
      </div>

      <!-- 警告 -->
      <div v-if="warnings.length > 0" class="plugin-install-warnings">
        <div
          v-for="(w, i) in warnings"
          :key="i"
          class="plugin-install-warning"
        >
          ⚠️ {{ w }}
        </div>
      </div>

      <!-- 强制停止提示：覆盖安装时该插件正在后台运行，落盘前会先停它 -->
      <div v-if="showForceStopNotice" class="plugin-install-running-notice">
        ⏻ 该插件正在后台运行，安装前会<strong>自动停止</strong>其进程，
        安装完成后自动用新版本重启。
      </div>

      <!-- 数据同步提醒：申请了 sync 权限时才出现，说明「会动你云端的哪一块数据」 -->
      <div v-if="requestsSync" class="plugin-install-sync-notice">
        <div class="sync-notice-title">☁️ 该插件会使用「数据同步」</div>
        <ul class="sync-notice-list">
          <li>
            它会触发你配置的云端备份（当前为 WebDAV）上传 / 下载，
            <strong>对象是整份数据</strong>：设置、订阅、已安装插件及其数据，
            而不是它自己的一小块。
          </li>
          <li>
            因此它有可能读取到<strong>其它同样会被同步的插件数据</strong>，
            请确认它来自可信来源。
          </li>
          <li>
            未在「设置 → 备份与同步」里配置同步时，该能力不可用；
            你也可以随时在那里关闭同步，或到「设置 → 插件」撤销此权限。
          </li>
        </ul>
      </div>

      <!-- 本次更新内容：仅在升级且存在 changelog 时展示（多行按行保留） -->
      <div v-if="changelogText" class="plugin-install-changelog">
        <div class="plugin-install-changelog-title">
          v{{ installedVersion }} → v{{ manifest?.version }} 更新内容
        </div>
        <div class="plugin-install-changelog-body">{{ changelogText }}</div>
      </div>

      <!-- 权限列表 -->
      <div class="plugin-install-perms">
        <h4>请求权限</h4>
        <div v-if="permBlocks.length === 0" class="plugin-install-no-perms">
          该插件未请求任何权限。
        </div>
        <div
          v-for="block in permBlocks"
          :key="block.group"
          class="plugin-install-perm-group"
        >
          <div class="perm-group-title">
            {{ block.title }}
            <span
              class="perm-group-risk"
              :class="'risk-' + block.risk"
            >
              {{ { low: "低风险", medium: "中风险", high: "高风险", critical: "极高风险" }[block.risk] }}
            </span>
          </div>
          <div
            v-for="entry in block.entries"
            :key="entry.raw"
            class="plugin-install-perm-item"
          >
            <span class="perm-item-name">{{ entry.spec.title }}</span>
            <span v-if="entry.scope" class="perm-item-scope">
              范围：{{ entry.scope }}
            </span>
            <span class="perm-item-desc">{{ entry.spec.desc }}</span>
          </div>
        </div>
      </div>

      <!-- 插件级自动更新开关（安装/升级时展示：插件声明 autoUpdate: true 时默认开启，用户可关闭） -->
      <div v-if="showAutoUpdate !== false" class="plugin-install-autoupdate">
        <div class="autoupdate-text">
          <div class="autoupdate-title">
            <span>自动更新此插件</span>
            <span class="autoupdate-suggest">
              插件建议：{{ manifest?.autoUpdate === true ? "开启" : "关闭" }}
            </span>
          </div>
          <div class="autoupdate-desc">
            开启后定时检测并在后台静默安装新版本（可在「设置 → 插件」中随时修改）
          </div>
        </div>
        <label
          class="install-switch"
          :class="{ on: autoUpdate === true }"
          :title="autoUpdate ? '自动更新已开启（点击关闭）' : '自动更新已关闭（点击开启）'"
        >
          <input
            type="checkbox"
            data-act="install-auto-update"
            :checked="autoUpdate === true"
            @change="emit('update:autoUpdate', !autoUpdate)"
          />
          <span class="install-switch-track" aria-hidden="true">
            <span class="install-switch-thumb"></span>
          </span>
        </label>
      </div>

      <!-- 操作按钮 -->
      <div class="plugin-install-actions">
        <button class="cfg-btn ghost" @click="emit('cancel')">
          取消
        </button>
        <button
          ref="okBtn"
          class="cfg-btn primary"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-install-changelog {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(91, 91, 214, 0.22);
  background: rgba(91, 91, 214, 0.06);
}

.plugin-install-changelog-title {
  font-size: 12px;
  font-weight: 600;
  color: #4a4ab8;
  margin-bottom: 4px;
}

.plugin-install-changelog-body {
  font-size: 12px;
  line-height: 1.6;
  color: #4b5563;
  white-space: pre-line;
  word-break: break-word;
  max-height: 180px;
  overflow-y: auto;
}

:global(html.theme-dark) .plugin-install-changelog {
  border-color: rgba(139, 139, 255, 0.28);
  background: rgba(139, 139, 255, 0.08);
}

:global(html.theme-dark) .plugin-install-changelog-title {
  color: #a5a5f5;
}

:global(html.theme-dark) .plugin-install-changelog-body {
  color: #c3c7cf;
}

.plugin-install-autoupdate {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(128, 136, 150, 0.22);
  background: rgba(128, 136, 150, 0.06);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.autoupdate-text {
  min-width: 0;
  flex: 1 1 auto;
}

.autoupdate-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #1f2329);
}

:global(html.theme-dark) .autoupdate-title {
  color: #e4e6ea;
}

.autoupdate-suggest {
  font-size: 11px;
  font-weight: 400;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--muted, #6b7280);
  background: rgba(128, 136, 150, 0.14);
}

:global(html.theme-dark) .autoupdate-suggest {
  color: #98a0ab;
  background: rgba(255, 255, 255, 0.08);
}

.autoupdate-desc {
  margin-top: 3px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--muted, #6b7280);
}

:global(html.theme-dark) .autoupdate-desc {
  color: #98a0ab;
}

.install-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  cursor: pointer;
  user-select: none;
}

.install-switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  pointer-events: none;
}

.install-switch-track {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: rgba(128, 136, 150, 0.38);
  padding: 2px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  transition: background-color 0.18s ease;
}

.install-switch-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
  transition: transform 0.18s ease;
}

.install-switch.on .install-switch-track,
.install-switch input:checked + .install-switch-track {
  background: var(--brand, #5b5bd6);
}

.install-switch.on .install-switch-thumb,
.install-switch input:checked + .install-switch-track .install-switch-thumb {
  transform: translateX(16px);
}
</style>
