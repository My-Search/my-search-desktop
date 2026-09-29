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
}>();

const emit = defineEmits<{
  (e: "confirm"): void;
  (e: "cancel"): void;
}>();

const okBtn = ref<HTMLButtonElement | null>(null);

watch(
  () => props.visible,
  (v) => {
    if (v) nextTick(() => okBtn.value?.focus());
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
