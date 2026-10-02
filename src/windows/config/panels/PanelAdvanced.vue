<script setup lang="ts">
/**
 * 高级设置面板（目前收纳「代理」功能）。
 *
 * 代理改为**规则驱动**：只有目标主机命中规则时请求才走系统代理，其余直连。
 * - 总开关：关闭后即使命中规则也不走代理（所有请求直连）；
 * - 规则列表：一份**可编辑的文本清单**（一行一条，命中走代理），默认预置
 *   github.com 等；点「编辑规则」在弹出框里直接改，可「恢复默认」；
 * - 规则库：默认预置 gfwlist，可增删来源；后台按间隔定时拉取并缓存，
 *   也可点「立即更新」。
 *
 * 代理地址本身仍沿用**系统代理**（含环境变量兜底），此处不单独配置地址；
 * 若系统未配置代理，即使命中规则也只能直连，面板顶部会给出提示。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import CfgHint from "./CfgHint.vue";
import {
  getProxySettings,
  setProxySettings,
  updateProxyRulesNow,
  DEFAULT_PROXY_SETTINGS,
  DEFAULT_GFWLIST_URL,
} from "../../../lib/tauri-bridge.ts";
import type { ProxyInfo, ProxyRuleSource, ProxySettings } from "../../../types/index.ts";

const emit = defineEmits<{ (e: "capturing", v: boolean): void }>();

const props = defineProps<{
  notify: (text: string, type?: "ok" | "error") => void;
}>();

/** 当前配置副本（表单双向绑定） */
const settings = ref<ProxySettings>({ ...DEFAULT_PROXY_SETTINGS });
/** 默认规则 + 系统代理状态 */
const info = ref<ProxyInfo | null>(null);

const loading = ref(true);
const saving = ref(false);
const updating = ref(false);

/** 规则库地址输入框 */
const sourceInput = ref("");

/** 是否开启状态（派生，便于模板判断） */
const enabled = computed(() => settings.value.enabled);

/** 上次更新时间文案 */
const lastUpdatedText = computed(() => {
  if (!settings.value.lastUpdatedMs) return "从未更新";
  return new Date(settings.value.lastUpdatedMs).toLocaleString();
});

/** 规则条数（展示用） */
const ruleCount = computed(() => settings.value.rules.length);

/** 读取配置 */
async function load(): Promise<void> {
  loading.value = true;
  try {
    const { settings: s, info: i } = await getProxySettings();
    settings.value = s;
    info.value = i;
  } catch (e) {
    console.warn("读取代理设置失败:", e);
  } finally {
    loading.value = false;
  }
}

/** 保存配置（总开关/规则/规则库变动后调用） */
async function save(successText?: string): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    await setProxySettings(settings.value);
    if (successText) props.notify(successText, "ok");
  } catch (e) {
    props.notify((e as Error)?.message ?? "保存代理设置失败", "error");
  } finally {
    saving.value = false;
  }
}

/** 切换总开关：先乐观更新，保存失败则回滚 */
async function toggleEnabled(): Promise<void> {
  if (loading.value || saving.value) return;
  const next = !settings.value.enabled;
  settings.value.enabled = next;
  saving.value = true;
  try {
    await setProxySettings(settings.value);
    props.notify(
      next
        ? "已开启代理：命中规则的请求将走系统代理。"
        : "已关闭代理：所有请求直连（即使命中规则）。",
      "ok"
    );
  } catch (e) {
    settings.value.enabled = !next;
    props.notify((e as Error)?.message ?? "保存代理设置失败", "error");
  } finally {
    saving.value = false;
  }
}

// ===================== 规则编辑弹框 =====================

/** 弹框是否显示 */
const rulesDialogOpen = ref(false);
/** 弹框里的文本域内容（一行一条） */
const rulesDraft = ref("");
const dialogEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);

/** 把文本解析为规则列表：去空行、去注释（# / !）、大小写去重、保序。 */
function parseRulesText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || s.startsWith("!") || s.startsWith("[")) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** 把遮罩送入 / 移出 top layer（与 MessageDialog 同一套做法）。 */
function syncTopLayer(visible: boolean): void {
  const el = dialogEl.value as (HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  }) | null;
  if (!el) return;
  try {
    if (visible) {
      if (!el.matches(":popover-open") && typeof el.showPopover === "function") {
        el.showPopover();
      }
    } else if (el.matches(":popover-open")) {
      el.hidePopover?.();
    }
  } catch {
    /* 不支持 popover：靠 CSS z-index 兜底 */
  }
}

/** 打开规则编辑弹框 */
function openRulesEditor(): void {
  if (saving.value) return;
  rulesDraft.value = settings.value.rules.join("\n");
  rulesDialogOpen.value = true;
}

/** 恢复为默认规则清单 */
function resetRulesDraft(): void {
  rulesDraft.value = (info.value?.defaultRules ?? []).join("\n");
}

/** 关闭弹框（不保存） */
function closeRulesEditor(): void {
  rulesDialogOpen.value = false;
}

/** 应用编辑：解析文本 → 保存 → 关闭 */
async function applyRules(): Promise<void> {
  const rules = parseRulesText(rulesDraft.value);
  settings.value.rules = rules;
  rulesDialogOpen.value = false;
  await save(`已保存 ${rules.length} 条规则。`);
}

/** 弹框打开时的顶层处理 + 聚焦；关闭时释放。Esc 关闭（期间 App 的 Esc 被 capturing 让路） */
function onDialogKeydown(e: KeyboardEvent): void {
  if (!rulesDialogOpen.value) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeRulesEditor();
  }
}

watch(
  rulesDialogOpen,
  (v) => {
    emit("capturing", v);
    nextTick(() => {
      syncTopLayer(v);
      if (v) textareaEl.value?.focus();
    });
  },
  { immediate: true, flush: "post" }
);

// ===================== 规则库 =====================

/** 添加规则库地址 */
async function addSource(): Promise<void> {
  const url = sourceInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    props.notify("规则库地址需以 http(s):// 开头。", "error");
    return;
  }
  if (settings.value.ruleSources.some((s) => s.url === url)) {
    props.notify("该规则库地址已存在。", "error");
    return;
  }
  settings.value.ruleSources.push({ url, enabled: true });
  sourceInput.value = "";
  await save("已添加规则库地址。");
}

/** 删除规则库地址（按地址删除，避免响应式代理引用比较的不确定性） */
async function removeSource(source: ProxyRuleSource): Promise<void> {
  settings.value.ruleSources = settings.value.ruleSources.filter((s) => s.url !== source.url);
  await save("已删除规则库地址。");
}

/** 启用/禁用某个规则库地址 */
async function toggleSource(source: ProxyRuleSource): Promise<void> {
  source.enabled = !source.enabled;
  await save(source.enabled ? "已启用该规则库。" : "已禁用该规则库。");
}

/** 更新间隔变更（小时） */
async function onIntervalChange(): Promise<void> {
  const h = Math.floor(Number(settings.value.updateIntervalHours));
  settings.value.updateIntervalHours = Number.isFinite(h) && h >= 1 ? Math.min(h, 24 * 30) : 24;
  await save("已保存更新间隔。");
}

/** 立即更新规则库 */
async function updateNow(): Promise<void> {
  if (updating.value) return;
  updating.value = true;
  try {
    const res = await updateProxyRulesNow();
    settings.value.lastUpdatedMs = Date.now();
    settings.value.libraryRuleCount = res.ruleCount;
    if (res.updated) {
      const extra = res.errors.length ? `（部分来源失败：${res.errors.length} 个）` : "";
      props.notify(`规则库已更新，共 ${res.ruleCount} 条规则${extra}。`, "ok");
    } else {
      const reason = res.errors[0] ?? "未知原因";
      props.notify(`规则库更新失败：${reason}`, "error");
    }
    // 重新读取 info（例如系统代理状态可能变化）
    await load();
  } catch (e) {
    props.notify((e as Error)?.message ?? "规则库更新失败", "error");
  } finally {
    updating.value = false;
  }
}

/** 恢复默认 gfwlist 规则库地址 */
async function fillGfwlist(): Promise<void> {
  if (settings.value.ruleSources.some((s) => s.url === DEFAULT_GFWLIST_URL)) {
    props.notify("gfwlist 已在规则库列表中。", "ok");
    return;
  }
  settings.value.ruleSources.push({ url: DEFAULT_GFWLIST_URL, enabled: true });
  await save("已恢复默认 gfwlist 规则库，点「立即更新」可拉取。");
}

onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  emit("capturing", false);
});
</script>

<template>
  <section class="page advanced">
    <!-- ====== 代理 ====== -->
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>代理</h3>
        <CfgHint
          text="代理不再全局生效：只有目标主机命中下方规则时，请求才走系统代理；其余一律直连。代理地址沿用系统/环境变量里的设置。"
        />
      </div>

      <!-- 总开关 -->
      <div class="general-row">
        <div class="general-info">
          <span class="general-label">启用规则代理</span>
          <span class="general-desc">
            关闭后所有请求直连（即使命中规则也不走代理）；开启后仅命中规则的请求走系统代理
          </span>
        </div>
        <label
          class="switch"
          :class="{ on: enabled, disabled: loading || saving }"
          title="启用规则代理（默认开启）"
        >
          <input
            type="checkbox"
            data-act="proxy-enabled"
            :checked="enabled"
            :disabled="loading || saving"
            @change="toggleEnabled"
          />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
        </label>
      </div>

      <!-- 系统代理状态提示 -->
      <div
        v-if="info"
        class="proxy-status"
        :class="{ warn: enabled && !info.systemProxyConfigured }"
      >
        <template v-if="info.systemProxyConfigured">
          <span class="proxy-status-dot ok"></span>
          已检测到系统代理：
          <code>{{ info.systemHttps || info.systemHttp }}</code>
        </template>
        <template v-else>
          <span class="proxy-status-dot warn"></span>
          未检测到系统代理（系统/环境变量均未配置）。此时即使命中规则也只能直连。
        </template>
      </div>

      <!-- 规则列表 -->
      <div class="proxy-section">
        <div class="proxy-section-head">
          <span class="general-label">规则</span>
          <span class="proxy-section-hint">命中即走代理；子域名自动命中（如 github.com 命中 api.github.com）</span>
        </div>
        <div class="proxy-chips" v-if="settings.rules.length">
          <span v-for="r in settings.rules" :key="r" class="proxy-chip">{{ r }}</span>
        </div>
        <div v-else class="proxy-empty">规则为空（所有请求直连）</div>
        <div class="proxy-add-row">
          <button class="cfg-btn" :disabled="saving" @click="openRulesEditor">
            编辑规则（{{ ruleCount }}）
          </button>
        </div>
      </div>

      <!-- 规则库 -->
      <div class="proxy-section">
        <div class="proxy-section-head">
          <span class="general-label">规则库</span>
          <span class="proxy-section-hint">定时拉取的在线规则（如 gfwlist），解析后并入规则集</span>
        </div>

        <div v-if="settings.ruleSources.length" class="proxy-source-list">
          <div v-for="s in settings.ruleSources" :key="s.url" class="proxy-source-row">
            <label
              class="switch small"
              :class="{ on: s.enabled, disabled: saving }"
              title="启用/禁用该规则库"
            >
              <input
                type="checkbox"
                :checked="s.enabled"
                :disabled="saving"
                @change="toggleSource(s)"
              />
              <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
            </label>
            <span class="proxy-source-url" :title="s.url">{{ s.url }}</span>
            <button
              type="button"
              class="chip-remove"
              :disabled="saving"
              title="删除"
              @click="removeSource(s)"
            >×</button>
          </div>
        </div>
        <div v-else class="proxy-empty">暂无规则库地址</div>

        <div class="proxy-add-row">
          <input
            class="cfg-input"
            type="url"
            v-model="sourceInput"
            placeholder="https://…/gfwlist.txt"
            :disabled="saving"
            @keydown.enter.prevent="addSource"
          />
          <button class="cfg-btn" :disabled="saving || !sourceInput.trim()" @click="addSource">
            添加
          </button>
          <button class="cfg-btn ghost" :disabled="saving" @click="fillGfwlist">
            填入 gfwlist
          </button>
        </div>

        <!-- 更新间隔 + 立即更新 -->
        <div class="proxy-update-row">
          <label class="proxy-interval">
            自动更新间隔
            <input
              class="cfg-input interval"
              type="number"
              min="1"
              max="720"
              v-model.number="settings.updateIntervalHours"
              :disabled="saving"
              @change="onIntervalChange"
            />
            小时
          </label>
          <button class="cfg-btn primary" :disabled="updating" @click="updateNow">
            {{ updating ? "更新中…" : "立即更新" }}
          </button>
        </div>
        <div class="proxy-update-meta">
          上次更新：{{ lastUpdatedText }} · 规则库规则数：{{ settings.libraryRuleCount }}
        </div>
      </div>
    </div>

    <!-- ====== 规则编辑弹框（一行一条文本，直接编辑） ====== -->
    <div
      ref="dialogEl"
      class="token-overlay"
      :class="{ show: rulesDialogOpen }"
      popover="manual"
      @click.self="closeRulesEditor"
      @keydown="onDialogKeydown"
    >
      <div class="token-dialog rules-dialog">
        <h3>编辑规则</h3>
        <p>
          一行一条，命中即走代理（子域名自动命中）。以 <code>#</code> 或
          <code>!</code> 开头的行视为注释；支持 <code>*.example.com</code>、
          <code>||example.com^</code> 等写法。
        </p>
        <textarea
          ref="textareaEl"
          class="rules-textarea"
          spellcheck="false"
          placeholder="github.com&#10;example.com&#10;*.cdn.example.com"
          v-model="rulesDraft"
        ></textarea>
        <div class="token-actions">
          <button class="cfg-btn ghost" :disabled="saving" @click="resetRulesDraft">
            恢复默认
          </button>
          <button class="cfg-btn ghost" @click="closeRulesEditor">取消</button>
          <button class="cfg-btn primary" :disabled="saving" @click="applyRules">保存</button>
        </div>
      </div>
    </div>
  </section>
</template>
