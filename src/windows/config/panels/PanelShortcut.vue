<script setup lang="ts">
/**
 * 快捷键面板（原 panes.shortcut + paneBinders.shortcut）。
 *
 * 目前只有一项：全局呼出/隐藏。后续新增快捷功能时在 SHORTCUT_ITEMS 追加条目。
 * 录入交互：点击按钮进入录入态 → 按下组合键完成录入（Esc 取消 / Backspace 清空）；
 * 保存时若后端注册失败（被占用等）会报错并回到当前生效值。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { setToggleShortcut } from "../../../lib/tauri-bridge";
import { escapeHtml } from "../../../lib/util";
import { comboToString, interpretKeydown, shortcutToCaps, validateCombo } from "../../../lib/shortcut";

const props = defineProps<{
  /** 当前生效值（bootstrap 时从后端读取） */
  saved: string;
  notify: (text: string, type?: "ok" | "error") => void;
  /** 保存成功后同步外部状态 */
  onSaved: (value: string) => void;
}>();

/** 待保存值（null = 未改动） */
const pending = ref<string | null>(null);
/** 是否处于录入态 */
const capturing = ref(false);
/** 录入失败提示（显示在按钮上） */
const invalidReason = ref("");
/** 全局 keydown 让路标志（App 的 Esc 关窗需要知道是否正在录入） */
const emit = defineEmits<{ (e: "capturing", v: boolean): void }>();

/** 当前展示值：pending（未保存的录入）优先，否则为已生效值 */
const displayValue = computed(() => pending.value ?? props.saved);

/** 「当前生效值」的键帽数组 */
const caps = computed(() => shortcutToCaps(displayValue.value));

/** 录入按钮文案 */
const captureText = computed(() => {
  if (capturing.value) return "按下新的组合键…（Esc 取消）";
  if (invalidReason.value) return invalidReason.value;
  if (pending.value != null) return shortcutToCaps(displayValue.value).join(" + ");
  return "点击修改快捷键";
});

function startCapture(): void {
  if (capturing.value) {
    stopCapture();
    return;
  }
  capturing.value = true;
  invalidReason.value = "";
  emit("capturing", true);
}

function stopCapture(): void {
  capturing.value = false;
  emit("capturing", false);
  invalidReason.value = "";
}

/** 把 pending 保存到后端并立即生效 */
async function saveShortcut(): Promise<void> {
  const value = pending.value;
  if (value == null) return;
  try {
    await setToggleShortcut(value);
    props.onSaved(value);
    pending.value = null;
    props.notify("快捷键已保存并生效。", "ok");
  } catch (e) {
    // 注册失败（被占用等）：丢弃待保存值，回到当前生效值的展示
    pending.value = null;
    props.notify((e as Error).message ?? String(e), "error");
  }
}

/** 全局 keydown：录入态时独占按键 */
function onKeydown(e: KeyboardEvent): void {
  if (!capturing.value) return;
  // 拦截所有按键（含 Tab / 空格），录入期间不触发页面其它行为（含 Esc 关窗）
  e.preventDefault();
  e.stopPropagation();

  const parsed = interpretKeydown(e);
  if (parsed.kind === "cancel") {
    stopCapture();
    return;
  }
  if (parsed.kind === "clear") {
    // 清空 = 复位为「当前生效值」
    pending.value = null;
    stopCapture();
    return;
  }
  if (parsed.kind !== "combo") return; // modifier-only / ignore：继续等待主键

  const check = validateCombo(parsed.modifiers, parsed.mainKey);
  if (!check.ok) {
    invalidReason.value = check.reason ?? "不支持该按键";
    return;
  }
  pending.value = comboToString(parsed.modifiers, parsed.mainKey);
  stopCapture();
  void saveShortcut();
}

/** 恢复默认：直接保存默认值（立即生效） */
function resetDefault(): void {
  if (capturing.value) stopCapture();
  pending.value = "ctrl+alt+s";
  void saveShortcut();
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown, true);
  emit("capturing", false);
});

defineExpose({ isCapturing: () => capturing.value });

/** 转义后的键帽（v-html 用；键帽来自固定映射，无用户输入） */
const capsHtml = computed(() =>
  caps.value
    .map((cap) => `<kbd class="kbd">${escapeHtml(cap)}</kbd>`)
    .join('<span class="kbd-plus">+</span>')
);
</script>

<template>
  <section class="page shortcut">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>快捷键</h3>
        <span class="cfg-hint">组合键需包含 Ctrl / Alt / Shift / Win 至少一个修饰键</span>
      </div>
      <div class="shortcut-row" data-shortcut-id="toggle">
        <div class="shortcut-info">
          <span class="shortcut-label">呼出 / 隐藏搜索框</span>
          <span class="shortcut-desc">在任意应用中按下该组合键，呼出或收起搜索框（原快捷键 Ctrl+Alt+S）</span>
        </div>
        <div class="shortcut-value">
          <span class="shortcut-caps" title="当前快捷键" v-html="capsHtml"></span>
          <button
            type="button"
            class="shortcut-capture"
            :class="{ capturing: capturing, invalid: !!invalidReason }"
            data-act="capture"
            title="点击后按下新的组合键"
            aria-label="点击录入新的快捷键"
            @click="startCapture"
          >
            {{ captureText }}
          </button>
          <button
            type="button"
            class="cfg-btn ghost shortcut-reset"
            data-act="reset"
            title="恢复为默认快捷键 Ctrl+Alt+S"
            @click="resetDefault"
          >
            恢复默认
          </button>
        </div>
      </div>
      <div class="cfg-note">
        点击「点击后按下新的组合键…」进入录入状态，按下组合键即完成录入；
        Esc 取消录入，Backspace 清空。保存后立即生效；
        若提示注册失败，说明该组合键已被系统或其它程序占用，请换一个。
      </div>
    </div>
  </section>
</template>
