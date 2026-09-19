<script setup lang="ts">
/**
 * 快捷键面板（原 panes.shortcut + paneBinders.shortcut）。
 *
 * 每条快捷键由三部分组成（新）：
 *   1. **快捷键**：录入组合键（点击 → 按下 → 完成；Esc 取消 / Backspace 清空）
 *   2. **作用类型**：呼出 / 隐藏搜索框（必有且仅一条） | 打开插件
 *   3. **作用对象**：作用类型为「打开插件」时，下拉选择某个已安装插件
 *
 * 保存策略：任何一处改动（录入、切换类型、切换插件、删除）都会立即提交给
 * Rust 端整体重新注册并持久化；注册失败（被占用等）时回滚到上次生效值并提示。
 *
 * 插件列表按需读取（动态 import 插件注册表），避免把插件模块图带进设置窗口首屏。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getShortcutBindings, setShortcutBindings } from "../../../lib/tauri-bridge";
import { escapeHtml } from "../../../lib/util";
import { comboToString, interpretKeydown, shortcutToCaps, validateCombo } from "../../../lib/shortcut";
import {
  canRemoveBinding,
  describeBinding,
  MAX_SHORTCUT_BINDINGS,
  nextFreeShortcut,
  parseBindings,
  validateBindings,
  type ShortcutAction,
  type ShortcutBinding,
} from "../../../lib/shortcut-bindings";

const props = defineProps<{
  /** 当前生效值（bootstrap 时从后端读取） */
  saved: ShortcutBinding[];
  notify: (text: string, type?: "ok" | "error") => void;
  /** 保存成功后同步外部状态 */
  onSaved: (value: ShortcutBinding[]) => void;
  /** 跳转到「插件」面板（未安装插件时的引导） */
  goPlugins?: () => void;
}>();

/** 列表项 = 绑定 + 稳定的 key（Vue 渲染用；不能用下标，删除后会串位） */
interface Row extends ShortcutBinding {
  key: number;
}
let nextKey = 1;
function toRows(list: readonly ShortcutBinding[]): Row[] {
  return list.map((b) => ({ ...b, key: nextKey++ }));
}

/** 当前编辑中的列表（提交失败会回滚为 lastSaved） */
const rows = ref<Row[]>(toRows(props.saved));
/** 上次生效的绑定（失败回滚 / 「清空」复位用） */
let lastSaved: ShortcutBinding[] = props.saved.map((b) => ({ ...b }));

/** 正在录入的行 key（null = 未录入）；同一时刻只允许一行录入 */
const capturingKey = ref<number | null>(null);
/** 录入失败提示（显示在对应行按钮上） */
const invalidReason = ref("");
/** 全局 keydown 让路标志（App 的 Esc 关窗需要知道是否正在录入） */
const emit = defineEmits<{ (e: "capturing", v: boolean): void }>();

// ===================== 插件列表（作用对象的候选项） =====================
interface PluginOption {
  id: string;
  name: string;
  /** 是否可用于「打开插件」（已启用且提供了界面） */
  openable: boolean;
  /** 状态说明（已禁用 / 无界面） */
  note: string;
}

const plugins = ref<PluginOption[]>([]);

/**
 * 读取已安装插件（仅取面板需要的字段）。
 * 动态 import：插件注册表模块（manifest/permissions）不在设置窗口首屏模块图里。
 */
async function loadPlugins(): Promise<void> {
  try {
    const { loadRegistry } = await import("../../../lib/plugins/registry");
    const reg = loadRegistry();
    plugins.value = reg.plugins
      .filter((p) => p.source.kind !== "legacy")
      .map((p) => {
        const hasView = p.manifest?.contributes?.detailView != null;
        const openable = p.enabled && hasView;
        return {
          id: p.id,
          name: p.name || p.id,
          openable,
          note: !p.enabled ? "已禁用" : !hasView ? "无界面" : "",
        };
      });
  } catch (e) {
    console.warn("读取插件列表失败（快捷键面板）:", e);
    plugins.value = [];
  }
}

/** 插件 id → 名称（已卸载的返回 null，展示时退化为 id） */
function pluginNameOf(id: string): string | null {
  const p = plugins.value.find((x) => x.id === id);
  if (!p) return null;
  return p.openable ? p.name : `${p.name}（${p.note}）`;
}

/** 某一行插件下拉的候选项：已知插件 + 当前值（可能已卸载，保留展示以便删除） */
function pluginOptionsFor(row: ShortcutBinding): PluginOption[] {
  const list = [...plugins.value];
  const target = row.target ?? "";
  if (target !== "" && !list.some((p) => p.id === target)) {
    list.unshift({ id: target, name: target, openable: false, note: "已卸载" });
  }
  return list;
}

// ===================== 展示 =====================
/** 当前生效的绑定（提交给后端用；去掉 UI 的 key） */
function currentBindings(): ShortcutBinding[] {
  return rows.value.map((r) => ({ shortcut: r.shortcut, action: r.action, target: r.target }));
}

/** 某行的键帽 HTML */
function capsHtmlOf(row: ShortcutBinding): string {
  return shortcutToCaps(row.shortcut)
    .map((cap) => `<kbd class="kbd">${escapeHtml(cap)}</kbd>`)
    .join('<span class="kbd-plus">+</span>');
}

/** 某行的说明文案（作用类型 + 作用对象） */
function describeOf(row: ShortcutBinding): string {
  return describeBinding(row, pluginNameOf);
}

/** 某行录入按钮的文案 */
function captureTextOf(row: Row): string {
  if (capturingKey.value === row.key) return "按下新的组合键…（Esc 取消）";
  if (invalidRowKey.value === row.key && invalidReason.value) return invalidReason.value;
  return "点击修改快捷键";
}

/** 最近一次录入失败的行（把错误文案留在那一行上） */
const invalidRowKey = ref<number | null>(null);

/** 是否还能新增（上限与后端一致） */
const canAdd = computed(() => rows.value.length < MAX_SHORTCUT_BINDINGS);

/** 其它行是否已占用「呼出 / 隐藏搜索框」（全局只能一条） */
function hasOtherToggle(row: Row): boolean {
  return rows.value.some((r) => r.key !== row.key && r.action === "toggle-window");
}

/** 是否有可打开的插件（决定「打开插件」作用类型是否可选） */
const hasOpenablePlugin = computed(() => plugins.value.some((p) => p.openable));

// ===================== 录入交互 =====================
function startCapture(row: Row): void {
  if (capturingKey.value === row.key) {
    stopCapture();
    return;
  }
  capturingKey.value = row.key;
  invalidReason.value = "";
  invalidRowKey.value = null;
  emit("capturing", true);
}

function stopCapture(): void {
  capturingKey.value = null;
  invalidReason.value = "";
  emit("capturing", false);
}

/** 全局 keydown：录入态时独占按键 */
function onKeydown(e: KeyboardEvent): void {
  const key = capturingKey.value;
  if (key == null) return;
  const row = rows.value.find((r) => r.key === key);
  if (!row) {
    stopCapture();
    return;
  }
  // 拦截所有按键（含 Tab / 空格），录入期间不触发页面其它行为（含 Esc 关窗）
  e.preventDefault();
  e.stopPropagation();

  const parsed = interpretKeydown(e);
  if (parsed.kind === "cancel") {
    stopCapture();
    return;
  }
  if (parsed.kind === "clear") {
    // 清空 = 复位为「当前生效值」（不发起保存）
    const saved = lastSaved.find((b) => b.action === row.action && b.target === row.target);
    if (saved) row.shortcut = saved.shortcut;
    stopCapture();
    return;
  }
  if (parsed.kind !== "combo") return; // modifier-only / ignore：继续等待主键

  const check = validateCombo(parsed.modifiers, parsed.mainKey);
  if (!check.ok) {
    invalidReason.value = check.reason ?? "不支持该按键";
    invalidRowKey.value = row.key;
    return;
  }
  const shortcut = comboToString(parsed.modifiers, parsed.mainKey);
  // 同键重复：直接在录入环节拦下（后端也会拒，但这里提示更及时）
  if (rows.value.some((r) => r.key !== row.key && r.shortcut === shortcut)) {
    invalidReason.value = `「${shortcutToCaps(shortcut).join(" + ")}」已被其它快捷键占用`;
    invalidRowKey.value = row.key;
    return;
  }
  const previous = row.shortcut;
  row.shortcut = shortcut;
  stopCapture();
  void persist({
    revert: () => {
      row.shortcut = previous;
    },
    errorKey: row.key,
  });
}

// ===================== 提交 =====================
/**
 * 提交当前列表：先本地校验 → 后端整体注册 + 持久化。
 * 失败时回滚（revert 优先，其次整体回到 lastSaved）并提示。
 */
async function persist(opts: { revert?: () => void; errorKey?: number; successText?: string } = {}): Promise<void> {
  const bindings = currentBindings();
  const verdict = validateBindings(bindings);
  if (!verdict.ok) {
    opts.revert?.();
    rows.value = toRows(lastSaved);
    props.notify(verdict.reason ?? "快捷键设置无效", "error");
    return;
  }
  try {
    await setShortcutBindings(bindings);
    lastSaved = bindings.map((b) => ({ ...b }));
    props.onSaved(lastSaved);
    invalidReason.value = "";
    invalidRowKey.value = null;
    if (opts.successText) props.notify(opts.successText, "ok");
  } catch (e) {
    opts.revert?.();
    rows.value = toRows(lastSaved);
    const text = (e as Error)?.message ?? String(e);
    invalidReason.value = text;
    invalidRowKey.value = opts.errorKey ?? null;
    props.notify(text, "error");
  }
}

// ===================== 行操作 =====================
/** 作用类型切换 */
function onActionChange(row: Row, value: string): void {
  const action = value as ShortcutAction;
  if (action === row.action) return;
  if (action === "toggle-window") {
    // 呼出/隐藏只能一条：切回去时清掉作用对象
    row.action = "toggle-window";
    row.target = null;
  } else {
    row.action = "open-plugin";
    // 默认选中第一个可打开的插件（没有则留空，等用户选）
    const first = plugins.value.find((p) => p.openable);
    row.target = first ? first.id : null;
  }
  void persist({ errorKey: row.key });
}

/** 作用对象（插件）切换 */
function onTargetChange(row: Row, value: string): void {
  row.target = value === "" ? null : value;
  void persist({ errorKey: row.key });
}

/** 恢复默认呼出键 */
function resetToggle(row: Row): void {
  if (capturingKey.value === row.key) stopCapture();
  const previous = row.shortcut;
  row.shortcut = "ctrl+alt+s";
  void persist({
    revert: () => {
      row.shortcut = previous;
    },
    errorKey: row.key,
    successText: "已恢复默认快捷键 Ctrl+Alt+S。",
  });
}

/** 删除一条绑定（呼出/隐藏不可删） */
function removeBinding(row: Row): void {
  if (!canRemoveBinding(row)) return;
  if (capturingKey.value === row.key) stopCapture();
  rows.value = rows.value.filter((r) => r.key !== row.key);
  void persist({ successText: "快捷键已删除。" });
}

/** 新增一条：默认「打开插件」+ 第一个可用插件 + 一个没被占用的组合键 */
function addBinding(): void {
  const shortcut = nextFreeShortcut(currentBindings());
  if (shortcut == null) {
    props.notify("可用的默认组合键已用尽（Ctrl+Alt+1~9 / F1~12），请先删除一条。", "error");
    return;
  }
  const first = plugins.value.find((p) => p.openable);
  if (!first) {
    props.notify("还没有可打开的插件，请先到「插件」面板安装并启用插件。", "error");
    return;
  }
  rows.value.push({
    key: nextKey++,
    shortcut,
    action: "open-plugin",
    target: first.id,
  });
  void persist({ successText: `已添加快捷键 ${shortcutToCaps(shortcut).join(" + ")}（打开插件）。` });
}

// ===================== 生命周期 =====================
function onWindowFocus(): void {
  void loadPlugins();
}

onMounted(async () => {
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("focus", onWindowFocus);
  // 以后端当前值为准（外部状态可能已被别的入口改过）
  try {
    const fromBackend = await getShortcutBindings();
    const list = parseBindings(fromBackend);
    lastSaved = list.map((b) => ({ ...b }));
    rows.value = toRows(list);
  } catch (e) {
    console.warn("读取快捷键设置失败:", e);
  }
  await loadPlugins();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("focus", onWindowFocus);
  emit("capturing", false);
});

defineExpose({ isCapturing: () => capturingKey.value !== null });

/** 「打开插件」但没有可选项时的引导文案 */
const emptyPluginHint = computed(() =>
  hasOpenablePlugin.value ? "" : "尚未安装可打开的插件，装好插件后即可为它设置快捷键"
);
</script>

<template>
  <section class="page shortcut">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>快捷键</h3>
        <span class="cfg-hint">组合键需包含 Ctrl / Alt / Shift / Win 至少一个修饰键</span>
      </div>

      <div
        v-for="row in rows"
        :key="row.key"
        class="shortcut-row"
        :data-shortcut-id="row.action === 'toggle-window' ? 'toggle' : 'plugin-' + (row.target ?? '')"
      >
        <div class="shortcut-info">
          <!-- 作用类型 -->
          <div class="shortcut-selects">
            <select
              class="shortcut-select"
              data-act="action"
              :value="row.action"
              :disabled="row.action === 'toggle-window'"
              :title="row.action === 'toggle-window' ? '呼出 / 隐藏搜索框是必需能力，只能改键、不能改类型' : '选择这条快捷键的作用类型'"
              @change="onActionChange(row, ($event.target as HTMLSelectElement).value)"
            >
              <!-- 呼出/隐藏全局只允许一条：别的行已占用时本项不可选 -->
              <option value="toggle-window" :disabled="hasOtherToggle(row)">呼出 / 隐藏搜索框</option>
              <option value="open-plugin">打开插件</option>
            </select>
            <!-- 作用对象（仅「打开插件」） -->
            <select
              v-if="row.action === 'open-plugin'"
              class="shortcut-select"
              data-act="target"
              :value="row.target ?? ''"
              title="选择这条快捷键要打开的插件"
              @change="onTargetChange(row, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">请选择插件…</option>
              <option
                v-for="p in pluginOptionsFor(row)"
                :key="p.id"
                :value="p.id"
                :disabled="!p.openable && p.id !== row.target"
              >
                {{ p.openable ? p.name : `${p.name}（${p.note}）` }}
              </option>
            </select>
          </div>
          <span class="shortcut-desc">{{ describeOf(row) }}</span>
        </div>

        <div class="shortcut-value">
          <span class="shortcut-caps" title="当前快捷键" v-html="capsHtmlOf(row)"></span>
          <button
            type="button"
            class="shortcut-capture"
            :class="{ capturing: capturingKey === row.key, invalid: invalidRowKey === row.key && !!invalidReason }"
            data-act="capture"
            title="点击后按下新的组合键"
            aria-label="点击录入新的快捷键"
            @click="startCapture(row)"
          >
            {{ captureTextOf(row) }}
          </button>
          <button
            v-if="row.action === 'toggle-window'"
            type="button"
            class="cfg-btn ghost shortcut-reset"
            data-act="reset"
            title="恢复为默认快捷键 Ctrl+Alt+S"
            @click="resetToggle(row)"
          >
            恢复默认
          </button>
          <button
            v-else
            type="button"
            class="cfg-btn ghost shortcut-remove"
            data-act="remove"
            title="删除这条快捷键"
            @click="removeBinding(row)"
          >
            删除
          </button>
        </div>
      </div>

      <div class="shortcut-add-row">
        <button
          type="button"
          class="cfg-btn shortcut-add"
          data-act="add"
          :disabled="!canAdd"
          :title="canAdd ? '新增一条快捷键' : `最多 ${MAX_SHORTCUT_BINDINGS} 条`"
          @click="addBinding"
        >
          + 添加快捷键
        </button>
        <template v-if="!hasOpenablePlugin">
          <button
            v-if="goPlugins"
            type="button"
            class="cfg-btn ghost shortcut-go-plugins"
            data-act="go-plugins"
            @click="goPlugins()"
          >
            去安装插件
          </button>
          <span class="cfg-hint">{{ emptyPluginHint }}</span>
        </template>
      </div>

      <div class="cfg-note">
        每条快捷键 = 快捷键 + 作用类型 + 作用对象：点「点击修改快捷键」进入录入状态，
        按下组合键即完成录入；Esc 取消录入，Backspace 清空。「呼出 / 隐藏搜索框」是必需能力
        （只能改键），其余条目可切换为「打开插件」并在右侧下拉选择具体插件。
        保存后立即生效；若提示注册失败，说明该组合键已被系统或其它程序占用，请换一个。
      </div>
    </div>
  </section>
</template>
