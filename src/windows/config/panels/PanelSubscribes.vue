<script setup lang="ts">
/**
 * 订阅管理面板（原 panes.subscribes + paneBinders.subscribes）。
 *
 * - 条块视图：逐条查看/拖拽排序/行内编辑/删除
 * - 源码视图：直接编辑 <tis::… /> 原文
 * - 顶部工具条：计数 + 重置为默认订阅 + 条块/源码切换
 * - 底部添加订阅（折叠/展开表单）
 */
import { ref, computed, nextTick, watch } from "vue";
import { getDefaultSubscribeText } from "../../../lib/tauri-bridge";
import { parseAllDesignatedSingTags, rebuildTags } from "../../../lib/subscribe-parser";
import { SUB_ITEM_ICON } from "./subItemIcon";
import type { SubscribeDraftApi } from "../useSubscribeDraft";
import type { SubscribeRow } from "../configShared";

const props = defineProps<{
  draft: SubscribeDraftApi;
  /** 提示（toast） */
  notify: (text: string, type?: "ok" | "error") => void;
  /** 确认框 */
  confirm: (text: string) => Promise<boolean>;
  /** 订阅文本变化后刷新「可提交数」等外部状态 */
  onChange: () => void;
}>();

/** 条块列表（从草稿派生） */
const rows = computed<SubscribeRow[]>(() => props.draft.items());

const taRef = ref<HTMLTextAreaElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const addWrapRef = ref<HTMLElement | null>(null);

/**
 * 读取「添加订阅」表单当前值。
 * 与原实现一致：动作时直接从 DOM 读，而不是依赖 v-model —— 面板由用户输入
 * 之外的方式（测试、自动填充、脚本）写值时不触发 input 事件，读 DOM 更可靠。
 */
function readAddForm(): { url: string; name: string; describe: string } {
  const wrap = addWrapRef.value;
  const q = (sel: string) =>
    (wrap?.querySelector<HTMLInputElement>(sel)?.value ?? "").trim();
  return {
    url: q(".sub-add-url"),
    name: q(".sub-add-name"),
    describe: q(".sub-add-describe"),
  };
}

/** 读取行内编辑表单当前值（同上，直接读 DOM） */
function readEditForm(row: SubscribeRow): { name: string; describe: string; url: string } {
  const rowEl = listRef.value?.querySelector<HTMLElement>(
    `.sub-item.editing[data-index="${row.index}"]`
  );
  const q = (sel: string) =>
    (rowEl?.querySelector<HTMLInputElement>(sel)?.value ?? "").trim();
  return {
    name: q(".sub-edit-name"),
    describe: q(".sub-edit-describe"),
    url: q(".sub-edit-url"),
  };
}

/** 视图切换：条块 / 源码 */
function switchView(view: "cards" | "src"): void {
  if (view === props.draft.state.view) return;
  if (view === "src") {
    // 条块 -> 源码：无未保存的编辑态可直接切
    props.draft.state.view = "src";
    props.draft.state.addOpen = false;
    props.draft.state.editIndex = null;
  } else {
    // 源码 -> 条块：先把文本域内容收回 state，再重渲染
    stashTextarea();
    props.draft.state.view = "cards";
  }
}

/** 将当前文本域里的内容收回草稿（离开源码视图前调用，避免编辑丢失） */
function stashTextarea(): void {
  if (taRef.value) props.draft.state.draft = taRef.value.value;
}

watch(
  () => props.draft.state.view,
  async (v) => {
    if (v === "src") {
      await nextTick();
      if (taRef.value) taRef.value.value = props.draft.state.draft;
    }
  }
);

/** 重置为默认订阅 */
async function resetDefaults(): Promise<void> {
  if (props.draft.state.editIndex != null) {
    props.notify("请先完成当前编辑操作。", "error");
    return;
  }
  if (!(await props.confirm("确定重置为默认订阅吗？这将覆盖当前所有订阅，不可撤销。"))) return;
  try {
    const defaults = await getDefaultSubscribeText();
    props.draft.commit(defaults);
    props.draft.state.addOpen = false;
    props.draft.state.editIndex = null;
    props.draft.state.view = "cards";
    props.onChange();
    props.notify("已重置为默认订阅。", "ok");
  } catch (e) {
    props.notify("获取默认订阅失败: " + (e as Error).message, "error");
  }
}

/** 开始编辑某条 */
function startEdit(row: SubscribeRow): void {
  props.draft.state.editIndex = row.index;
  props.draft.state.addOpen = false;
  // 等编辑行渲染出来再聚焦名称框
  void nextTick(() => {
    const input = listRef.value?.querySelector<HTMLInputElement>(".sub-item.editing .sub-edit-name");
    input?.focus();
  });
}

/** 取消编辑 */
function cancelEdit(): void {
  props.draft.state.editIndex = null;
}

/** 保存编辑 */
function saveEdit(row: SubscribeRow): void {
  const { name, describe, url } = readEditForm(row);
  if (!url) {
    props.notify("订阅地址不能为空。", "error");
    return;
  }
  // 重建这一条：保留其它未知属性，仅更新 title / describe / 地址
  const meta = parseAllDesignatedSingTags(row.body, "tis")[0] || ({} as Record<string, string>);
  const { tabName, tabValue, title, describe: _oldDescribe, ...rest } = meta as Record<string, string>;
  const next = [...rows.value];
  next[row.index] = {
    ...row,
    url,
    name: name || url,
    describe,
    body: rebuildTags([
      {
        tabName: tabName ?? "tis",
        tabValue: url,
        ...rest,
        ...(name ? { title: name } : {}),
        ...(describe ? { describe } : {}),
      },
    ]),
  };
  props.draft.state.editIndex = null;
  props.draft.writeItems(next);
  props.onChange();
  props.notify("订阅已更新。", "ok");
}

/** 删除某条 */
async function removeRow(row: SubscribeRow): Promise<void> {
  if (!(await props.confirm(`确定删除订阅「${row.name}」吗？`))) return;
  const next = rows.value.filter((it) => it.index !== row.index);
  props.draft.state.editIndex = null;
  props.draft.writeItems(next);
  props.onChange();
  props.notify("订阅已删除。", "ok");
}

/** 打开订阅地址 */
function openRow(url: string): void {
  if (url) void import("../../../lib/tauri-bridge").then((m) => m.openExternal(url));
}

/** 展开/收起添加表单 */
function toggleAdd(): void {
  props.draft.state.addOpen = !props.draft.state.addOpen;
  props.draft.state.editIndex = null;
  // 展开时清空上一次的残留值并聚焦地址框
  void nextTick(() => {
    const wrap = addWrapRef.value;
    if (!wrap || !props.draft.state.addOpen) return;
    wrap.querySelectorAll<HTMLInputElement>("input").forEach((el) => (el.value = ""));
    wrap.querySelector<HTMLInputElement>(".sub-add-url")?.focus();
  });
}

/** .sub-add-wrap 键盘处理：表单折叠时让浏览器默认行为（按钮点击）处理 Enter/Esc；
 *  表单展开时由这里接管（修复 #15：折叠态阻止了按钮的 Enter 默认行为）。 */
function onAddWrapKeydown(e: KeyboardEvent): void {
  if (!props.draft.state.addOpen) return; // 折叠态不干预，按钮默认行为正常触发
  if (e.key === "Enter") {
    e.preventDefault();
    confirmAdd();
  } else if (e.key === "Escape") {
    e.preventDefault();
    toggleAdd();
  }
}

/** 确认添加 */
function confirmAdd(): void {
  const { url, name, describe } = readAddForm();
  if (!url) {
    props.notify("请先填写订阅地址。", "error");
    return;
  }
  const items = rows.value;
  if (items.some((it) => it.url === url)) {
    props.notify("该订阅已存在（地址重复）。", "error");
    return;
  }
  const attrs: Record<string, string> = {};
  if (name) attrs.title = name;
  if (describe) attrs.describe = describe;
  const body = rebuildTags([{ tabName: "tis", tabValue: url, ...attrs }]);
  props.draft.state.addOpen = false;
  props.draft.state.editIndex = null;
  props.draft.writeItems([...items, { index: items.length, url, name: name || url, describe, body }]);
  props.onChange();
  props.notify("订阅已添加。", "ok");
}

// ---------- 拖拽排序（HTML5 DnD） ----------
const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);

function onDragStart(e: DragEvent, row: SubscribeRow): void {
  if (props.draft.state.editIndex != null) {
    e.preventDefault();
    return;
  }
  dragIndex.value = row.index;
  // 修复 #16：拖动时添加 dim/dashed 视觉反馈（还原原版 dragging class）
  const el = (e.target as HTMLElement)?.closest(".sub-item");
  if (el) el.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", String(row.index));
    } catch {
      /* ignore */
    }
  }
}

function onDragEnd(): void {
  // 修复 #16：清理拖动样式
  document.querySelectorAll(".sub-item.dragging").forEach((el) => el.classList.remove("dragging"));
  dragIndex.value = null;
  dragOverIndex.value = null;
}

function onDragOver(e: DragEvent, row: SubscribeRow): void {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dragOverIndex.value = row.index === dragIndex.value ? null : row.index;
}

function onDrop(e: DragEvent, row: SubscribeRow): void {
  e.preventDefault();
  const from = dragIndex.value;
  const to = row.index;
  dragOverIndex.value = null;
  dragIndex.value = null;
  if (from == null || from === to) return;
  const items = [...rows.value];
  const fromPos = items.findIndex((it) => it.index === from);
  const toPos = items.findIndex((it) => it.index === to);
  if (fromPos < 0 || toPos < 0) return;
  const [moved] = items.splice(fromPos, 1);
  items.splice(toPos, 0, moved);
  props.draft.writeItems(items);
  props.onChange();
}
</script>

<template>
  <section class="page subscribes" :class="{ 'src-mode': props.draft.state.view === 'src' }">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>订阅总览</h3>
        <span
          class="cfg-hint-icon"
          title="每行一个 <tis::… />，支持 title / describe 属性"
          aria-label="每行一个 <tis::… />，支持 title / describe 属性"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </span>
      </div>
      <!-- 顶部工具条：计数 + 操作按钮 -->
      <div class="sub-toolbar">
        <span class="sub-count">共 {{ rows.length }} 条订阅</span>
        <button
          type="button"
          class="sub-reset"
          data-act="reset-defaults"
          title="重置为默认订阅（覆盖当前所有订阅）"
          aria-label="重置为默认订阅"
          @click="resetDefaults"
        >
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
        <div class="sub-view-toggle" role="tablist">
          <button
            type="button"
            data-view="cards"
            :class="{ on: props.draft.state.view === 'cards' }"
            title="按条块管理每条订阅"
            @click="switchView('cards')"
          >
            条块
          </button>
          <button
            type="button"
            data-view="src"
            :class="{ on: props.draft.state.view === 'src' }"
            title="直接编辑 <tis::… /> 原文（高级）"
            @click="switchView('src')"
          >
            源码
          </button>
        </div>
      </div>
      <!-- 条块列表 -->
      <div class="sub-list" ref="listRef" @dragend="onDragEnd">
        <template v-if="rows.length === 0">
          <div class="sub-empty">
            暂无订阅。点击下方「＋ 添加订阅」，或切到「源码」直接粘贴 &lt;tis::… /&gt; 文本。
          </div>
        </template>
        <template v-else>
          <template v-for="row in rows" :key="row.index">
          <!-- 行内编辑态 -->
          <div
            v-if="props.draft.state.editIndex === row.index"
            class="sub-item editing"
            :data-index="row.index"
            @keydown.enter.prevent="saveEdit(row)"
            @keydown.esc.stop="cancelEdit"
          >
            <span class="sub-icon" aria-hidden="true" v-html="SUB_ITEM_ICON"></span>
            <div class="sub-main">
              <input class="sub-edit-name" :value="row.name" placeholder="订阅名称" />
              <input class="sub-edit-describe" :value="row.describe" placeholder="描述（可选）" />
              <input class="sub-edit-url sub-url" :value="row.url" placeholder="https://…/index.ms" />
            </div>
            <div class="sub-ops">
              <button class="sub-op" data-act="save-edit" title="确定" @click="saveEdit(row)">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button class="sub-op" data-act="cancel-edit" title="取消" @click="cancelEdit">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          <!-- 普通展示态 -->
          <div
            v-else
            class="sub-item"
            :class="{ 'drag-over': dragOverIndex === row.index }"
            :data-index="row.index"
            draggable="true"
            @dragstart="onDragStart($event, row)"
            @dragover="onDragOver($event, row)"
            @drop="onDrop($event, row)"
          >
            <button type="button" class="sub-drag" title="拖拽排序" aria-label="拖拽排序">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                <circle cx="9" cy="6" r="1.6" />
                <circle cx="15" cy="6" r="1.6" />
                <circle cx="9" cy="12" r="1.6" />
                <circle cx="15" cy="12" r="1.6" />
                <circle cx="9" cy="18" r="1.6" />
                <circle cx="15" cy="18" r="1.6" />
              </svg>
            </button>
            <span class="sub-icon" aria-hidden="true" v-html="SUB_ITEM_ICON"></span>
            <div class="sub-main">
              <span class="sub-name" :title="row.name">{{ row.name }}</span>
              <span v-if="row.describe" class="sub-describe" :title="row.describe">{{
                row.describe
              }}</span>
              <span class="sub-url" :title="row.url">{{ row.url }}</span>
            </div>
            <div class="sub-ops">
              <button class="sub-op" data-act="open" title="打开订阅地址" @click="openRow(row.url)">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
              <button class="sub-op" data-act="edit" title="编辑" @click="startEdit(row)">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button class="sub-op danger" data-act="remove" title="删除" @click="removeRow(row)">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path
                    d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                  />
                </svg>
              </button>
            </div>
          </div>
          </template>
        </template>
      </div>
      <!-- 添加订阅（折叠态只有一个按钮） -->
      <div class="sub-add-wrap" ref="addWrapRef" @keydown="onAddWrapKeydown">
        <!-- 折叠按钮与表单都常驻 DOM（折叠时表单由 CSS 隐藏）：
             这样「点开 → 立即填值 → 点添加」在同一帧内也能正确取到输入值，
             与原实现（同步渲染表单）行为一致。 -->
        <button
          v-show="!props.draft.state.addOpen"
          type="button"
          class="sub-add-toggle"
          data-act="open-add"
          @click="toggleAdd"
        >
          ＋ 添加订阅
        </button>
        <div class="sub-add" :class="{ open: props.draft.state.addOpen }">
          <div class="sub-add-row">
            <input class="sub-add-url" placeholder="订阅地址（必填，https://…/index.ms）" />
          </div>
          <div class="sub-add-row">
            <input class="sub-add-name" placeholder="订阅名称（可选，默认取地址）" />
            <input class="sub-add-describe" placeholder="描述（可选）" />
          </div>
          <div class="sub-add-actions">
            <button type="button" class="cfg-btn ghost" data-act="close-add" @click="toggleAdd">
              取消
            </button>
            <button type="button" class="cfg-btn primary" data-act="confirm-add" @click="confirmAdd">
              添加
            </button>
          </div>
        </div>
      </div>
      <!-- 源码视图：保留原始文本域，仅源码模式下显示 -->
      <textarea
        id="all_subscribe"
        ref="taRef"
        spellcheck="false"
        placeholder='&lt;tis::https://…/index.ms title="订阅名" describe="描述" /&gt;'
        :value="props.draft.state.draft"
        @input="props.draft.state.draft = ($event.target as HTMLTextAreaElement).value"
      ></textarea>
    </div>
  </section>
</template>
