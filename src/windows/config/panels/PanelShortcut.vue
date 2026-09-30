<script setup lang="ts">
/**
 * 快捷键面板（原 panes.shortcut + paneBinders.shortcut）。
 *
 * 每条快捷键由三部分组成（新）：
 *   1. **快捷键**：录入组合键（点击 → 按下 → 完成；Esc 取消 / Backspace 清空）
 *   2. **作用类型**：呼出 / 隐藏搜索框（必有且仅一条） | 打开插件 | 快速过滤 | 快捷打开项
 *   3. **作用对象**：
 *        - 打开插件 → 下拉选择某个已安装插件
 *        - 快速过滤 → 填写常用头文本（按下后填入「常用头 + ` : `」并立即搜索）
 *        - 快捷打开项 → 填写匹配文本（按下后精确匹配数据项并直接打开）
 *
 * 保存策略：作用对象已填完整的行，任何改动（录入、切换类型、切换插件/改文本、删除）
 * 都会立即提交给 Rust 端整体重新注册并持久化；注册失败（被占用等）时回滚到上次生效值
 * 并提示。新增或切换类型后作用对象还没填完的行是「草稿」：不校验、不提交，等用户
 * 选完插件 / 填完文本（行变完整）后的下一次保存一并生效，不会在填写前弹出
 * 「需要选择一个插件」这类校验报错。草稿不落盘，切走面板（组件卸载）即丢弃。
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
  isBindingComplete,
  isPluginShortcutAction,
  MAX_SHORTCUT_BINDINGS,
  nextFreeShortcut,
  normalizeQuickFilterHeader,
  parseBindings,
  SEARCH_BOUNDARY,
  validateBindings,
  type ShortcutAction,
  type ShortcutBinding,
} from "../../../lib/shortcut-bindings";
import type { AvailableShortcutAction } from "../../../lib/plugins/shortcut-actions";
import CfgHint from "./CfgHint.vue";

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
 * 当前**已安装插件**提供的快捷键作用类型（截图 / 剪贴板历史这类）。
 *
 * 不写死：装了对应插件才有、卸载即消失（见 `availableShortcutActions`）。
 * 同一份数据也用于把「刚被卸载、但绑定还在（等宿主同步清理）」的动作标注出来。
 */
const pluginActions = ref<AvailableShortcutAction[]>([]);

/** 插件动作的展示标题（来自已安装插件的清单）；查不到返回空串 */
function actionTitleOf(action: string): string {
  return pluginActions.value.find((a) => a.action === action)?.title ?? "";
}

/** 插件名解析（给 describeBinding 展示「打开插件」的目标名） */
function pluginNameOf(id: string): string | null {
  return plugins.value.find((p) => p.id === id)?.name ?? null;
}

/**
 * 读取已安装插件（仅取面板需要的字段）。
 * 动态 import：插件注册表模块（manifest/permissions）不在设置窗口首屏模块图里。
 */
async function loadPlugins(): Promise<void> {
  try {
    const [{ loadRegistry }, { availableShortcutActions }] = await Promise.all([
      import("../../../lib/plugins/registry"),
      import("../../../lib/plugins/shortcut-actions"),
    ]);
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
    pluginActions.value = availableShortcutActions(reg);
  } catch (e) {
    console.warn("读取插件列表失败（快捷键面板）:", e);
    plugins.value = [];
    pluginActions.value = [];
  }
}

/**
 * 作用类型下拉的候选：内置四项 + 当前可用的插件动作。
 *
 * 插件动作只列**已安装**的（`pluginActions`）；若某条绑定引用了刚被卸载的动作
 * （宿主同步尚未跑完），把绑定自身的动作补进来展示，避免下拉「当前值不在选项里」
 * 而显示成空白（与插件下拉的「已卸载」兜底同一思路）。
 */
interface ActionOption {
  value: ShortcutAction;
  label: string;
}

function actionOptionsFor(row: ShortcutBinding | null): ActionOption[] {
  const opts: ActionOption[] = [
    { value: "toggle-window", label: "呼出 / 隐藏搜索框" },
    { value: "open-plugin", label: "打开插件" },
    { value: "quick-filter", label: "快速过滤" },
    { value: "quick-open", label: "快捷打开项" },
  ];
  const seen = new Set<string>(opts.map((o) => o.value));
  for (const a of pluginActions.value) {
    if (seen.has(a.action)) continue;
    seen.add(a.action);
    opts.push({ value: a.action as ShortcutAction, label: a.title });
  }
  // 行引用的插件动作当前不可用（插件已卸载）→ 补一条，标明「已卸载」
  if (row && isPluginShortcutAction(row.action) && !seen.has(row.action)) {
    const title = actionTitleOf(row.action) || describeBinding(row);
    opts.push({ value: row.action, label: `${title}（插件已卸载）` });
  }
  return opts;
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
/** 当前生效的绑定（提交给后端用；去掉 UI 的 key，文本型作用对象归一化后落盘） */
function currentBindings(): ShortcutBinding[] {
  return rows.value.map((r) => {
    let target: string | null;
    if (r.action === "quick-filter") {
      target = normalizeQuickFilterHeader(r.target) || null;
    } else if (r.action === "quick-open") {
      target = String(r.target ?? "").trim() || null;
    } else {
      target = r.target;
    }
    return { shortcut: r.shortcut, action: r.action, target };
  });
}

/** 某行的键帽 HTML */
function capsHtmlOf(row: ShortcutBinding): string {
  return shortcutToCaps(row.shortcut)
    .map((cap) => `<kbd class="kbd">${escapeHtml(cap)}</kbd>`)
    .join('<span class="kbd-plus">+</span>');
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
 * 提交当前列表：草稿行先剔除 → 本地校验 → 后端整体注册 + 持久化。
 * 作用对象没填完的行是草稿：不参与校验、不提交，等填完后的下一次保存一并生效。
 * 与上次生效值一致（如草稿行引发的空提交、删除一条从未提交的草稿）时直接跳过。
 * 失败时回滚（revert 优先，其次整体回到 lastSaved）并提示。
 */
async function persist(opts: { revert?: () => void; errorKey?: number; successText?: string } = {}): Promise<void> {
  const bindings = currentBindings().filter(isBindingComplete);
  if (JSON.stringify(bindings) === JSON.stringify(lastSaved)) return;
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
/**
 * 作用类型切换。
 *
 * 文本型作用对象（quick-filter / quick-open）切换时**不**清空旧 target：
 * 保留原值（哪怕它不适合新类型）让用户在输入框里手动覆盖即可；原值为空时
 * 该行只是暂存为草稿——不校验、不提交，填完再随下一次保存生效。
 * 「打开插件」切换后默认不选中插件，等用户手动选择（期间同样是草稿）。
 */
function onActionChange(row: Row, value: string): void {
  const action = value as ShortcutAction;
  if (action === row.action) return;
  if (action === "toggle-window") {
    // 呼出/隐藏只能一条：切回去时清掉作用对象
    row.action = "toggle-window";
    row.target = null;
  } else if (action === "quick-filter" || action === "quick-open") {
    // 文本型：保留原值（空值等用户填写，非空值等用户修改），避免切完就报校验错误
    row.action = action;
  } else if (action === "open-plugin") {
    row.action = "open-plugin";
    // 默认不选中插件，等用户手动选择
    row.target = null;
  } else {
    // 插件动作（截图 / 剪贴板历史）：无作用对象，执行器在宿主侧
    row.action = action;
    row.target = null;
  }
  void persist({ errorKey: row.key });
}

/** 作用对象（插件）切换 */
function onTargetChange(row: Row, value: string): void {
  row.target = value === "" ? null : value;
  void persist({ errorKey: row.key });
}

/** 该作用类型的文本型作用对象是否就是「匹配文本」（quick-open）而非「常用头」（quick-filter） */
function isOpenText(row: Row): boolean {
  return row.action === "quick-open";
}

/**
 * 文本型作用对象（快速过滤的常用头 / 快捷打开项的匹配文本）输入：本地实时更新
 * （受控 input），失焦时才提交。不在每次按键都提交——输入过程中必然出现空串/半成品，
 * 会反复触发校验报错与重注册。
 */
function onTextInput(row: Row, value: string): void {
  row.target = value;
}

/**
 * 文本型作用对象失焦：按作用类型归一化后提交。
 * 填了内容 → 行变完整，立即校验并保存；清空 → 行退回草稿（不校验、不提交），
 * 重新填完后的下一次失焦再保存。与上次生效值一致时 persist 内部会跳过重注册。
 * - 快速过滤：去掉手打的尾部「 : 」，避免拼成「百度翻译 :  : 」；
 * - 快捷打开项：只 trim（冒号可能是标题本身的一部分）。
 */
function onTextCommit(row: Row): void {
  const previous = row.target;
  const text = isOpenText(row)
    ? String(previous ?? "").trim()
    : normalizeQuickFilterHeader(previous);
  row.target = text === "" ? null : text;
  void persist({
    revert: () => {
      row.target = previous;
    },
    errorKey: row.key,
  });
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

/**
 * 新增一条：默认「打开插件」（作用对象留空，等用户手动选择）+ 一个没被占用的组合键。
 * 没有可打开的插件时退而新增一条「快速过滤」（常用头留空，等用户填写）。
 * 新增行此时是草稿——不校验、不提交；用户选完插件 / 填完常用头后才随保存生效。
 */
function addBinding(): void {
  const shortcut = nextFreeShortcut(currentBindings());
  if (shortcut == null) {
    props.notify("可用的默认组合键已用尽（Ctrl+Alt+1~9 / F1~12），请先删除一条。", "error");
    return;
  }
  if (!hasOpenablePlugin.value) {
    // 没有可打开的插件：给一条快速过滤（常用头留空，等用户填写）
    rows.value.push({ key: nextKey++, shortcut, action: "quick-filter", target: null });
    props.notify(`已添加快捷键 ${shortcutToCaps(shortcut).join(" + ")}（快速过滤，请填写常用头）。`, "ok");
    return;
  }
  rows.value.push({
    key: nextKey++,
    shortcut,
    action: "open-plugin",
    target: null,
  });
  props.notify(`已添加快捷键 ${shortcutToCaps(shortcut).join(" + ")}（打开插件，请选择插件）。`, "ok");
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

/**
 * 「作用类型」说明（卡片标题旁的疑问 icon 气泡）：用户对新类型不一定懂，逐条讲清。
 *
 * 截图 / 剪贴板历史这类**插件动作**的说明只在对应插件已安装时出现（随下拉一起
 * 动态增减），避免解释一堆「当前用不了」的类型。
 */
const ACTION_TYPES_HELP = computed(() => {
  const lines = [
    "呼出 / 隐藏搜索框：全局呼出或收起搜索窗（必需，只能一条）。",
    "打开插件：直接打开指定插件的界面，无需先搜关键词。",
    "快速过滤：把「常用头 + 空格冒号空格」填入搜索框并立即搜索，光标停在末尾，接着输入子关键词即可（如常用头「百度翻译」→ 填入「百度翻译 : 」）。",
    "快捷打开项：按填写的文本精确匹配数据项（标题 / 描述 / 内容，多个词用空格分隔、都要命中；不用模糊搜索），匹配到一项就直接打开，多项则列出结果，没有则提示。",
  ];
  for (const a of pluginActions.value) {
    if (a.action === "screenshot") {
      lines.push(
        "截图：按快捷键框选屏幕区域并标注，完成后可复制到剪贴板（由「截图」插件提供）。"
      );
    } else if (a.action === "clipboard") {
      lines.push(
        "剪贴板历史：按快捷键呼出剪贴板历史，查看 / 搜索 / 复制最近复制过的文本与图片（由「剪贴板历史」插件提供）。"
      );
    } else {
      lines.push(`${a.title}：由插件「${a.pluginId}」提供的动作。`);
    }
  }
  return lines.join("\n");
});

/** 没有可打开插件时的引导文案（此时「+ 添加快捷键」会新增一条「快速过滤」） */
const emptyPluginHint = computed(() =>
  hasOpenablePlugin.value
    ? ""
    : "尚未安装可打开的插件：「+ 添加快捷键」将新增一条「快速过滤」；装好插件后即可为它设置快捷键"
);
</script>

<template>
  <section class="page shortcut">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>快捷键</h3>
        <CfgHint :text="ACTION_TYPES_HELP" />
        <span class="cfg-hint">组合键需包含 Ctrl / Alt / Shift / Win 至少一个修饰键</span>
      </div>

      <!-- 行容器：subgrid 让所有行共用同一套列轨，键帽/录入/操作按钮逐行对齐 -->
      <div class="shortcut-grid">
      <div
        v-for="row in rows"
        :key="row.key"
        class="shortcut-row"
        :data-shortcut-id="
          row.action === 'toggle-window'
            ? 'toggle'
            : row.action === 'open-plugin'
              ? 'plugin-' + (row.target ?? '')
              : row.action + '-' + (row.target ?? '')
        "
      >
        <div class="shortcut-info">
          <!-- 作用类型 -->
          <select
            class="shortcut-select"
            data-act="action"
            :value="row.action"
            :disabled="row.action === 'toggle-window'"
            :title="row.action === 'toggle-window' ? '呼出 / 隐藏搜索框是必需能力，只能改键、不能改类型' : '选择这条快捷键的作用类型'"
            @change="onActionChange(row, ($event.target as HTMLSelectElement).value)"
          >
            <!-- 内置四项固定；插件动作（截图 / 剪贴板历史）随已安装插件动态增减；
                 行引用的是刚被卸载的插件动作时也补一条并标注「已卸载」 -->
            <option
              v-for="opt in actionOptionsFor(row)"
              :key="opt.value"
              :value="opt.value"
              :disabled="opt.value === 'toggle-window' && hasOtherToggle(row)"
            >
              {{ opt.label }}
            </option>
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
          <!-- 作用对象（「快速过滤」）：常用头文本，触发时自动补二次搜索分隔符 -->
          <div v-else-if="row.action === 'quick-filter'" class="shortcut-header">
            <input
              class="shortcut-input"
              data-act="target"
              type="text"
              :value="row.target ?? ''"
              placeholder="常用头，如：百度翻译"
              title="按下该键后，搜索框会填入「常用头 + 空格冒号空格」并立即搜索"
              spellcheck="false"
              autocomplete="off"
              @input="onTextInput(row, ($event.target as HTMLInputElement).value)"
              @blur="onTextCommit(row)"
            />
            <span class="shortcut-header-suffix" title="触发时自动追加的二次搜索分隔符">{{ SEARCH_BOUNDARY.trim() }}</span>
          </div>
          <!-- 作用对象（「快捷打开项」）：匹配文本，按下即精确匹配并打开 -->
          <div v-else-if="row.action === 'quick-open'" class="shortcut-header">
            <input
              class="shortcut-input solo"
              data-act="target"
              type="text"
              :value="row.target ?? ''"
              placeholder="要打开的项，如：百度翻译"
              title="按下该键后，按「标题 / 描述 / 内容」精确匹配该项并直接打开；多个词用空格分隔（都要命中）；多项匹配时列出结果"
              spellcheck="false"
              autocomplete="off"
              @input="onTextInput(row, ($event.target as HTMLInputElement).value)"
              @blur="onTextCommit(row)"
            />
          </div>
        </div>
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
        <!-- 操作按钮容器：固定在第四列，避免按钮宽度变化影响其他列 -->
        <div class="shortcut-actions">
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
    </div>
  </section>
</template>
