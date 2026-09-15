<script setup lang="ts">
/**
 * 数据缓存面板（原 panes.cache + paneBinders.cache）。
 *
 * - 统计各缓存键占用与条数
 * - 「订阅数据缓存」显示剩余有效期倒计时（每秒刷新，面板销毁/窗口隐藏时停止）
 * - 一键清理可重建缓存（订阅数据 + 订阅指纹）
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storageGet, storageRemove, formatCacheCountText } from "../../../lib/util";
import { formatBytes } from "../configShared";
import {
  CACHE_BLUEPRINT,
  CACHE_CLEAR_KEYS,
  SUBSCRIBES_KEY,
  type CacheEntry,
} from "../useCachePanel";
import type { SubscribeDraftApi } from "../useSubscribeDraft";

const props = defineProps<{
  draft: SubscribeDraftApi;
  notify: (text: string, type?: "ok" | "error") => void;
  confirm: (text: string) => Promise<boolean>;
}>();

/** 每秒刷新的「当前时间」，驱动缓存剩余有效期倒计时 */
const nowTick = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

function startCountdown(): void {
  stopCountdown();
  nowTick.value = Date.now();
  // 面板一旦没有可倒计时内容就自动停掉（不空转）
  timer = setInterval(() => {
    nowTick.value = Date.now();
    const hasCountdown = entries.value.some((e) => e.countdown);
    if (!hasCountdown) stopCountdown();
  }, 1000);
}

function stopCountdown(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 序列化体积（UTF-8 估算），仅用于展示相对大小 */
function rawByteSize(raw: unknown): number {
  if (raw == null) return 0;
  try {
    return new Blob([typeof raw === "string" ? raw : JSON.stringify(raw)]).size;
  } catch (e) {
    return 0;
  }
}

/** 订阅数据缓存是否已过期 */
function isCacheExpired(raw: unknown): boolean {
  if (raw == null || typeof raw !== "object") return false;
  const expire = Number((raw as { expire?: number }).expire);
  return Number.isFinite(expire) && expire > 0 && expire <= nowTick.value;
}

const entries = computed<CacheEntry[]>(() =>
  CACHE_BLUEPRINT.map((bp) => {
    // 订阅原文可能处于「已编辑未保存」状态，优先用草稿估算占用
    const raw =
      bp.key === SUBSCRIBES_KEY && props.draft.state.draft != null
        ? props.draft.state.draft
        : storageGet(bp.key, null);
    const bytes = rawByteSize(raw);
    const isSearchData = bp.key === "SEARCH_DATA_KEY";
    const expired = isSearchData && isCacheExpired(raw);
    let countText = "";
    if (raw != null) {
      if (isSearchData) {
        const data = Array.isArray((raw as { data?: unknown[] }).data)
          ? (raw as { data: unknown[] }).data
          : [];
        // 显示「剩余有效期」：未过期给出剩余时长 + 具体过期时刻，已过期给出失效时刻
        countText = formatCacheCountText(data.length, (raw as { expire?: number }).expire, nowTick.value);
      } else if (bp.key === "SUBSCRIBE_FINGERPRINT_CACHE_KEY") {
        countText = "已生成";
      } else if (Array.isArray(raw)) {
        const total = raw.reduce(
          (sum, it) => sum + (Number((it as { count?: number })?.count) || 0),
          0
        );
        countText =
          total > 0
            ? `${raw.length.toLocaleString()} 项 · ${total.toLocaleString()} 条`
            : `${raw.length.toLocaleString()} 项`;
      } else if (typeof raw === "object") {
        countText = `${Object.keys(raw).length.toLocaleString()} 项`;
      } else if (typeof raw === "string") {
        countText = `${raw.length.toLocaleString()} 字符`;
      }
    }
    return {
      key: bp.key,
      label: bp.label,
      desc: bp.desc,
      clearable: bp.clearable,
      bytes,
      sizeText: formatBytes(bytes),
      countText,
      expired,
      empty: bytes === 0,
      /** 该条目是否有「活的」剩余时间（驱动倒计时） */
      countdown: isSearchData && raw != null,
    };
  })
);

const totalBytes = computed(() => entries.value.reduce((sum, e) => sum + e.bytes, 0));
const totalText = computed(() => formatBytes(totalBytes.value));

/** 一键清理可重建缓存 */
async function clearDataCache(): Promise<void> {
  if (!(await props.confirm("确定清理可重建的数据缓存吗？主窗口将在下次唤出时重新加载订阅数据。"))) {
    return;
  }
  for (const key of CACHE_CLEAR_KEYS) storageRemove(key);
  nowTick.value = Date.now();
  props.notify("已清理数据缓存，主窗口将重新加载订阅数据。", "ok");
}

onMounted(startCountdown);

onBeforeUnmount(stopCountdown);

defineExpose({ stopCountdown, startCountdown });
</script>

<template>
  <section class="page cache">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>数据缓存</h3>
        <span class="cfg-hint">主窗口与设置窗口共用本地缓存</span>
      </div>
      <div class="cache-summary">
        <div class="cache-summary-main">
          <span class="cache-summary-label">本地缓存总占用</span>
          <span id="cacheTotalSize" class="cache-summary-value">{{ totalText }}</span>
        </div>
        <button id="clearDataCache" class="cfg-btn" @click="clearDataCache">清理可重建缓存</button>
      </div>
      <div id="cacheList" class="cache-list">
        <div
          v-for="e in entries"
          :key="e.key"
          class="cache-item"
          :class="{ empty: e.empty, expired: e.expired }"
          :data-key="e.key"
        >
          <div class="cache-item-main">
            <div class="cache-item-title">
              <span>{{ e.label }}</span
              ><span v-if="e.clearable" class="cache-badge">可清理</span>
            </div>
            <div class="cache-item-desc">{{ e.desc }}</div>
          </div>
          <div class="cache-item-meta">
            <span class="cache-size">{{ e.empty ? "空" : e.sizeText }}</span>
            <span v-if="e.countText" class="cache-count">{{ e.countText }}</span>
          </div>
        </div>
      </div>
      <div class="cfg-note">
        「订阅数据缓存 / 订阅指纹」可由订阅重新生成，清理后主窗口会在下次唤出时重新加载；
        其余为用户数据（订阅原文、关注标签、权重、历史等），仅统计占用、不在此处清理。
      </div>
    </div>
  </section>
</template>
