<script setup lang="ts">
/**
 * 环境变量授权选择器（宿主绘制的居中面板）。
 *
 * 观感对齐「微信授权」那类设计：一个居中的卡片，列出可选项，未授权的项上带
 * 「授权」按钮，点下去先就地确认「允许某个插件使用某个变量」，确认后才算授权。
 *
 * 安全约束（重要）：**本组件绝不渲染变量的值**。
 * 插件界面与宿主同 window（inlay 不是沙箱），任何出现在 DOM 里的明文都可能被
 * 插件脚本读走；因此列表只显示 名字 + 用途说明 + 授权状态，值一律以固定掩码代替。
 *
 * 受控组件：state 来自 useEnvPicker（visible / pluginName / purpose / granted），
 * ok 回传 {kind:"ref"|"literal"}，cancel 回传 null。
 */
import { computed, nextTick, ref, watch } from "vue";
import type { EnvPickerState, EnvPickerApi, EnvPickResult } from "../composables/useEnvPicker";
import { MASKED_VALUE, loadEnvVars, type EnvVar } from "../lib/plugins/env-store";

const props = defineProps<{
  /** 弹层状态（来自 useEnvPicker） */
  state: EnvPickerState;
  /**
   * 授权回调与状态更新的提供者（即 useEnvPicker 的返回值）。
   * 通过 props 传入而不是再写一份状态：`grant` 回调是「打开弹层时」
   * 才有的运行时依赖，放回 composable 里持有最自然。
   */
  api: EnvPickerApi;
}>();

const emit = defineEmits<{
  (e: "ok", result: EnvPickResult): void;
  (e: "cancel"): void;
}>();

/** 全部变量（名字/说明/是否密钥；**不含值**——值仅用于判断是否为空） */
const items = ref<EnvVar[]>([]);
const keyword = ref("");
const activeIndex = ref(-1);
/** 已授权（打开时来自 state，授权后就地追加） */
const granted = ref<string[]>([]);
/** 正在确认授权的变量名（行内确认态） */
const pendingGrant = ref<string | null>(null);
/** 正在写入授权 */
const granting = ref(false);
/** 手工输入模式 */
const manualMode = ref(false);
const manualValue = ref("");

const searchEl = ref<HTMLInputElement | null>(null);
const manualEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

/** 只保留「有名字」的项；过滤走名字与说明 */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return items.value;
  return items.value.filter(
    (v) =>
      v.name.toLowerCase().includes(kw) ||
      String(v.description ?? "").toLowerCase().includes(kw)
  );
});

function isGranted(name: string): boolean {
  return granted.value.includes(name);
}

watch(
  () => props.state.visible,
  async (v) => {
    if (!v) return;
    keyword.value = "";
    activeIndex.value = -1;
    pendingGrant.value = null;
    manualMode.value = false;
    manualValue.value = "";
    granted.value = [...(props.state.granted ?? [])];
    // 每次打开都重新读一遍：用户可能刚在设置窗口加了变量
    items.value = loadEnvVars();
    await nextTick();
    searchEl.value?.focus();
  }
);

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) emit("cancel");
}

/** 键盘：↑↓ 移动、Enter 选择、Esc 取消（与结果列表同款交互） */
async function onKeydown(e: KeyboardEvent): Promise<void> {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("cancel");
    return;
  }
  if (manualMode.value) return;
  const total = filtered.value.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (total === 0) return;
    activeIndex.value = activeIndex.value < 0 ? 0 : (activeIndex.value + 1) % total;
    await scrollActiveIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (total === 0) return;
    activeIndex.value = activeIndex.value < 0 ? total - 1 : (activeIndex.value - 1 + total) % total;
    await scrollActiveIntoView();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = filtered.value[activeIndex.value];
    if (item) void choose(item);
    else if (filtered.value.length === 1) void choose(filtered.value[0]);
  }
}

async function scrollActiveIntoView(): Promise<void> {
  await nextTick();
  const nodes = listEl.value?.querySelectorAll(".env-picker-row");
  const node = nodes?.[activeIndex.value] as HTMLElement | undefined;
  node?.scrollIntoView({ block: "nearest" });
}

/** 选中一项：已授权 → 直接返回引用；未授权 → 先就地确认授权 */
async function choose(item: EnvVar): Promise<void> {
  if (!isGranted(item.name)) {
    pendingGrant.value = item.name;
    return;
  }
  emit("ok", { kind: "ref", name: item.name, ref: `$${item.name}` });
}

/** 确认授权（真正的授权动作） */
async function confirmGrant(name: string): Promise<void> {
  if (granting.value) return;
  granting.value = true;
  try {
    const fn = props.api.grantClient();
    const ok = fn ? await fn(name) : false;
    if (!ok) {
      pendingGrant.value = null;
      return;
    }
    props.api.markGranted(name);
    granted.value = [...props.state.granted];
    pendingGrant.value = null;
    emit("ok", { kind: "ref", name, ref: `$${name}` });
  } finally {
    granting.value = false;
  }
}

function useManual(): void {
  manualMode.value = true;
  void nextTick(() => manualEl.value?.focus());
}

function confirmManual(): void {
  const v = manualValue.value;
  if (v === "") return;
  emit("ok", { kind: "literal", value: v });
}
</script>

<template>
  <div
    id="envPickerOverlay"
    class="env-picker-overlay"
    :class="{ show: props.state.visible }"
    @click="onOverlayClick"
  >
    <div class="env-picker-dialog" role="dialog" aria-modal="true" @keydown="onKeydown">
      <header class="env-picker-head">
        <h3>{{ props.state.title }}</h3>
        <p class="env-picker-sub">
          <template v-if="props.state.pluginName">
            为「{{ props.state.pluginName }}」选择要使用的环境变量
          </template>
          <template v-else>选择要使用的环境变量</template>
          <template v-if="props.state.purpose">：{{ props.state.purpose }}</template>
        </p>
      </header>

      <!-- 手工输入：逃生口（用户不想集中管理、只想填一次字面值） -->
      <div v-if="manualMode" class="env-picker-manual">
        <input
          ref="manualEl"
          v-model="manualValue"
          class="cfg-input"
          type="text"
          placeholder="直接填入值（不经环境变量存储）"
          spellcheck="false"
          autocomplete="off"
          @keydown.enter.prevent="confirmManual()"
        />
        <div class="env-picker-manual-actions">
          <button class="cfg-btn ghost" @click="manualMode = false">返回列表</button>
          <button class="cfg-btn primary" :disabled="manualValue === ''" @click="confirmManual">使用此值</button>
        </div>
      </div>

      <template v-else>
        <div class="env-picker-search">
          <input
            ref="searchEl"
            v-model="keyword"
            class="cfg-input"
            type="text"
            placeholder="搜索变量名 / 说明"
            spellcheck="false"
            autocomplete="off"
          />
        </div>

        <div ref="listEl" class="env-picker-list">
          <div
            v-for="(item, i) in filtered"
            :key="item.name"
            class="env-picker-row"
            :class="{ active: i === activeIndex, granted: isGranted(item.name) }"
            @mouseenter="activeIndex = i"
            @click="choose(item)"
          >
            <div class="env-picker-row-main">
              <div class="env-picker-name">
                <code>{{ item.name }}</code>
                <span v-if="isGranted(item.name)" class="badge env-picker-badge">已授权</span>
              </div>
              <div v-if="item.description" class="env-picker-desc">{{ item.description }}</div>
            </div>
            <!-- 值一律不渲染：只给固定掩码，避免明文进入插件可读的 DOM -->
            <div class="env-picker-mask">{{ MASKED_VALUE }}</div>
            <div class="env-picker-action">
              <span v-if="isGranted(item.name)" class="env-picker-arrow">选择</span>
              <button
                v-else
                class="btn-sm"
                @click.stop="choose(item)"
              >
                授权
              </button>
            </div>
          </div>

          <div v-if="items.length === 0" class="env-picker-empty">
            还没有环境变量。<br />
            请到「设置 → 环境变量」添加，或直接手工输入值。
          </div>
          <div v-else-if="filtered.length === 0" class="env-picker-empty">
            没有匹配「{{ keyword }}」的变量。
          </div>
        </div>

        <!-- 行内授权确认（真正的授权动作，取代原型里的 modal confirm） -->
        <div v-if="pendingGrant" class="env-picker-confirm">
          <span class="env-picker-confirm-text">
            <template v-if="props.state.pluginName">允许「{{ props.state.pluginName }}」</template>
            <template v-else>允许该插件</template>
            使用环境变量 <code>{{ pendingGrant }}</code>？
          </span>
          <span class="env-picker-confirm-actions">
            <button class="btn-sm" :disabled="granting" @click="pendingGrant = null">取消</button>
            <button class="btn-sm env-picker-allow" :disabled="granting" @click="confirmGrant(pendingGrant)">
              允许
            </button>
          </span>
        </div>

        <footer class="env-picker-foot">
          <button class="btn-link" @click="useManual">手工输入值</button>
          <button class="cfg-btn ghost" @click="emit('cancel')">取消</button>
        </footer>
      </template>
    </div>
  </div>
</template>
