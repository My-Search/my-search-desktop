<script setup lang="ts">
/**
 * 搜索框（原 #searchBox + #my_search_box 内部结构）。
 *
 * - 输入框：v-model + input 事件（防抖搜索由父层处理）
 * - 键盘：↑↓ 选择、Enter 打开、Ctrl+Enter 附加内容、Esc 隐藏、Tab 进/出 PRO 模式、Backspace 清标签
 * - 附件：粘贴文件/文件夹 → emit("attach")；#ms-input-files 渲染 chips，× 移除；
 *   识别为**图片**的附件直接显示缩略图（不显示文件名），其余显示图标 + 完整名称
 * - logo 按钮：左键 = 打开设置 / 右键 = 切换 [系统项]；**已下载好更新时左键改为安装**
 * - 更新提示：叶子**右下角**的小红箭头（仅下载完成后出现，见 UpdateBadge）
 */
import { computed, ref, watch } from "vue";
import { SEARCH_BOUNDARY } from "../../lib/search-engine";
import { LOGO_ICON } from "../../lib/assets";
import {
  attachmentPlaceholder,
  isPreviewImage,
  type AttachedEntry,
} from "../../lib/plugins/attachments";
import {
  gcBlobImages,
  getBlobImage,
  registerBlobImage,
} from "../../lib/plugins/clipboard-image";
import { attachmentPreview, clipboardFilePaths, describePaths } from "../../lib/plugins/ipc";
import { useFileIcons } from "./useFileIcons";
import UpdateBadge from "./UpdateBadge.vue";
import type { UpdateCheckerApi } from "./useUpdateChecker";

const props = defineProps<{
  /** 输入框内容（v-model） */
  modelValue: string;
  placeholder: string;
  /** 更新检查状态（决定叶子右下角是否显示「可安装」红箭头） */
  update: UpdateCheckerApi;
  /** 已附加到搜索框的文件/文件夹（父层持有状态，这里只渲染） */
  attachments?: AttachedEntry[];
  /** 系统正在向窗口拖入文件（Tauri 拖拽事件驱动的高亮） */
  dragging?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: string): void;
  (e: "input", v: string): void;
  (e: "keydown", ev: KeyboardEvent): void;
  (e: "settings"): void;
  (e: "badge-click"): void;
  (e: "system-item"): void;
  /** 粘贴/拖入解析出的附件（父层负责合并、过滤联动与 Rust 同步） */
  (e: "attach", entries: AttachedEntry[]): void;
  /** 移除第 index 个附件 */
  (e: "detach", index: number): void;
  /** 点击插件包 chip（.mspp） */
  (e: "chip-click", index: number): void;
}>();

const inputEl = ref<HTMLInputElement | null>(null);

/** 内部值：与父层 modelValue 双向同步 */
const value = computed({
  get: () => props.modelValue,
  set: (v: string) => emit("update:modelValue", v),
});

/** 是否已有「下载完成、可安装」的更新（决定叶子右下角小红箭头与点击语义） */
const updateReady = computed(() => props.update.isDownloaded());

/** 叶子按钮提示：仅在可安装时提示，其余保持无提示 */
const logoTitle = computed(() => (updateReady.value ? props.update.updateTip() : ""));

/** 有附件时替换默认占位，提示下一步（xxx : yyy）的用法 */
const placeholderText = computed(() =>
  (props.attachments?.length ?? 0) > 0
    ? attachmentPlaceholder(props.attachments!.length)
    : props.placeholder
);

/**
 * 图片缩略图缓存：`附件key` → data URL。
 *
 * 为什么放组件内而不到父层：缩略图是**渲染细节**（父层的附件状态只关心
 * kind/name/path，过滤与插件读取都不依赖它），失败时静默退回「图标 + 名称」，
 * 不影响任何功能。key 用 path（无 path 时退回 名称+类型），与附件去重键同源。
 */
const previews = ref<Record<string, string>>({});
/** 已在读取中的缩略图 key（避免同一附件重复发起读取） */
const previewLoading = new Set<string>();

/** 系统文件图标（资源管理器同款）。与「最近添加」条带共用模块级缓存，
 *  同一条目在两个组件里都命中同一份 data URL，不重复走 IPC。 */
const { iconOf: sysIconOf, prefetch: prefetchSysIcons } = useFileIcons();

function entryKey(f: AttachedEntry): string {
  const path = String(f.path ?? "").trim();
  if (path) return `p:${path}`;
  // 与 attachments.attachmentKey 同源：剪贴板位图（无路径、可能同名）按 blobKey 区分
  const blobKey = String(f.blobKey ?? "").trim();
  if (blobKey) return `b:${blobKey}`;
  return `n:${f.kind}:${f.name}`;
}

/** 是否为可预览图片（blobKey 或图片扩展名，见 attachments.isPreviewImage） */
function isImage(f: AttachedEntry): boolean {
  return isPreviewImage(f);
}

/** 是否为插件包（.mspp） */
function isPluginPackage(f: AttachedEntry): boolean {
  return f.kind === "file" && f.name.toLowerCase().endsWith(".mspp");
}

/** 取图片缩略图；未就绪/失败时返回空串 → 退回图标样式 */
function thumbOf(f: AttachedEntry): string {
  const key = entryKey(f);
  const cached = previews.value[key];
  if (cached) return cached;
  if (!isImage(f)) return "";

  // 剪贴板位图（截图等，无路径）：从内存旁挂表取 data URL。
  // 只读不写——内容由 onPaste 在 emit 之前就绪（见 registerBlobImage 的 await），
  // 因此这里不会在渲染期产生状态写入（避免 Vue 的更新循环告警）。
  if (f.blobKey) return getBlobImage(f.blobKey);

  if (!f.path) return "";
  if (previewLoading.has(key)) return "";
  previewLoading.add(key);
  void attachmentPreview(f.path)
    .then((dataUrl) => {
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
        previews.value = { ...previews.value, [key]: dataUrl };
      }
    })
    .catch(() => {
      /* 读取失败（过大/文件已删/未登记）：保持图标 + 名称，功能不受影响 */
    })
    .finally(() => {
      previewLoading.delete(key);
    });
  return "";
}

/**
 * 取非图片、非插件包附件的**系统图标**（空串 = 未就绪 / 取不到）。
 * 图片走缩略图、插件包走叶子图标，都不该被系统图标顶掉。
 */
function systemIconOf(f: AttachedEntry): string {
  if (f.kind !== "file" && f.kind !== "folder") return "";
  return sysIconOf(f);
}

// 附件列表变化时清理失效缩略图与剪贴板位图（避免缓存随会话无限增长）
watch(
  () => (props.attachments ?? []).map(entryKey),
  () => {
    const list = props.attachments ?? [];
    const aliveKeys = new Set(list.map(entryKey));
    const next: Record<string, string> = {};
    let changed = false;
    for (const [k, v] of Object.entries(previews.value)) {
      if (aliveKeys.has(k)) next[k] = v;
      else changed = true;
    }
    if (changed) previews.value = next;
    // 位图回收用 blobKey 本身的集合（与 render 键 `b:xxx` 不同域，各用各的）
    gcBlobImages(new Set(list.map((e) => String(e.blobKey ?? "")).filter(Boolean)));
    // 系统图标：预取本组件新出现的附件即可。**不在这里裁剪共享缓存**——
    // 条带里的条目恰好不在 attachments 里，按这份列表裁剪会误清它们；
    // 裁剪由同时持有两份状态的 App.vue 用并集完成（见 useFileIcons 注释）。
    prefetchSysIcons(list);
  }
);

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  emit("update:modelValue", v);
  emit("input", v);
}

function onKeydown(e: KeyboardEvent) {
  e.stopPropagation();
  emit("keydown", e);
}

function onKeyup(e: KeyboardEvent) {
  const keyword = (e.target as HTMLInputElement).value.trim();
  // "::" / "：：" → 子搜索分隔符
  if (keyword.endsWith("::") || keyword.endsWith("：：")) {
    let kw = keyword.replace(/::|：：/, SEARCH_BOUNDARY).replace(/\s+/, " ");
    kw = kw.replace(/((\s{1,2}:)+ )/, SEARCH_BOUNDARY);
    const upper = kw.toUpperCase();
    emit("update:modelValue", upper);
    emit("input", upper);
  }
}

/**
 * 把被 preventDefault 掉的纯文本粘贴补回去（异步查剪贴板文件失败的兜底）。
 * 优先 execCommand：保住原生撤销栈且会正常派发 input 事件；失败才手动拼接。
 */
function insertPlainText(target: EventTarget | null, text: string): void {
  if (!text) return;
  const el = (target as HTMLInputElement | null) ?? inputEl.value;
  if (!el) return;
  el.focus();
  let usedExec = false;
  try {
    usedExec = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  } catch (e) {
    usedExec = false;
  }
  if (usedExec) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  el.value = next;
  const pos = start + text.length;
  try {
    el.setSelectionRange(pos, pos);
  } catch (e) {
    /* ignore */
  }
  emit("update:modelValue", next);
  emit("input", next);
}

/**
 * 粘贴处理：
 * - 剪贴板里有文件/文件夹（CF_HDROP 或 web 层 File）→ 拦截默认行为，
 *   优先走 Rust 拿**真实路径 + 是否文件夹**（文件夹粘贴只有这条路可靠）；
 *   Rust 不可用时退回 web 层 File（只有名字，kind 一律按文件处理）；
 * - 纯文本粘贴不拦截，维持原生行为（包括撤销栈）。
 */
async function onPaste(e: ClipboardEvent): Promise<void> {
  const cd = e.clipboardData;
  if (!cd) return;
  const webFiles = Array.from(cd.files ?? []);
  const hasFileData = webFiles.length > 0 || Array.from(cd.types ?? []).includes("Files");
  if (!hasFileData) return; // 纯文本 → 原生粘贴

  e.preventDefault();
  const text = cd.getData("text/plain") ?? "";
  const target = e.target;

  let entries: AttachedEntry[] = [];
  try {
    const paths = await clipboardFilePaths();
    if (paths.length > 0) {
      const described = await describePaths(paths);
      entries = described.map((d) => ({
        kind: d.isDir ? ("folder" as const) : ("file" as const),
        name: d.name,
        path: d.path,
      }));
    }
  } catch (err) {
    entries = [];
  }
  if (entries.length === 0) {
    // web 层兜底：拿不到真实路径（浏览器/截图工具复制的图片等）。
    // 与老油猴版一致：跳过 text/* 类型，避免误伤富文本粘贴。
    const files = webFiles.filter((f) => !String(f.type || "").startsWith("text/"));
    entries = await Promise.all(
      files.map(async (f) => {
        // 图片（截图 / 复制图片）：读成 data URL 挂到旁挂表，条目带 blobKey 即可
        // 直接渲染缩略图——这是修复「截图粘贴退化成普通文件」的关键一步。
        const blobKey = await registerBlobImage(f);
        return {
          kind: "file" as const,
          name: f.name,
          path: "",
          ...(blobKey ? { blobKey } : {}),
        };
      })
    );
  }
  if (entries.length > 0) {
    emit("attach", entries);
    return;
  }
  // 声称有文件却一个都没解析出来：把文本粘贴还原，别让用户丢内容
  insertPlainText(target, text);
}

/** 供父层聚焦/读取/改写输入框 */
function focus(): void {
  inputEl.value?.focus();
}
function select(): void {
  inputEl.value?.select();
}
/** 聚焦并把光标移到末尾（快速过滤填入常用头后，用户直接接着输入子关键词） */
function focusEnd(): void {
  const el = inputEl.value;
  if (!el) return;
  el.focus();
  const end = el.value.length;
  try {
    el.setSelectionRange(end, end);
  } catch (e) {
    /* 个别环境不支持 setSelectionRange：仅聚焦也算可用 */
  }
}

defineExpose({ focus, select, focusEnd, element: inputEl });

// 父层改写 modelValue 时同步到原生 input（Vue 会处理，这里仅确保光标位置不丢）
watch(
  () => props.modelValue,
  () => {
    const el = inputEl.value;
    if (el && el.value !== props.modelValue) el.value = props.modelValue;
  }
);

/** logo 点击处理：**已下载好更新时左键 = 安装**（箭头角标只是在提示这一点），
    否则维持原行为——打开设置。 */
function onLogoClick() {
  if (updateReady.value) {
    emit("badge-click");
  } else {
    emit("settings");
  }
}

/** logo 右击菜单（切换 [系统项]） */
function onLogoContextMenu(e: MouseEvent) {
  e.preventDefault();
  emit("system-item");
}
</script>

<template>
  <div id="searchBox" :class="{ 'drag-over': props.dragging }">
    <div id="ms-input-files">
      <div
        v-for="(f, i) in props.attachments ?? []"
        :key="f.path || f.kind + ':' + f.name"
        class="ms-input-file"
        :class="{ 'is-folder': f.kind === 'folder', 'is-image': isImage(f), 'is-plugin-package': isPluginPackage(f) }"
        :title="f.path || f.name"
        @click="isPluginPackage(f) && emit('chip-click', i)"
      >
        <!-- 插件包（.mspp）：显示叶子图标，可点击触发安装 -->
        <template v-if="isPluginPackage(f)">
          <img class="chip-icon leaf-icon" :src="LOGO_ICON" alt="" />
          <span class="chip-name">{{ f.name }}</span>
        </template>
        <!-- 图片附件：直接显示缩略图，**不显示文件名**；读不到内容时退化为图标 -->
        <img v-else-if="isImage(f) && thumbOf(f)" class="chip-thumb" :src="thumbOf(f)" alt="" />
        <template v-else>
          <!-- 系统图标（资源管理器同款：Word 显示 Word 图标）优先；
               未就绪 / 取不到时退回内置 SVG（旧的通用文件夹与文件图形） -->
          <img
            v-if="systemIconOf(f)"
            class="chip-icon chip-sys-icon"
            :src="systemIconOf(f)"
            alt=""
          />
          <svg v-else class="chip-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <template v-if="f.kind === 'folder'">
              <path
                d="M1.75 4.25A1.5 1.5 0 0 1 3.25 2.75H6L7.5 4.25h5.25a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5v-7.5Z"
                fill="currentColor"
              />
            </template>
            <template v-else>
              <path
                d="M4 1.75h5.25L12.5 5v9.25h-8.5V1.75Zm5 .6V4.9h2.55"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linejoin="round"
              />
            </template>
          </svg>
          <!-- 图片（含缩略图尚未就绪/读取失败的情况）一律不带文件名 -->
          <span v-if="!isImage(f)" class="chip-name">{{ f.name }}</span>
        </template>
        <button
          type="button"
          class="chip-x"
          title="移除"
          @click.stop="emit('detach', i)"
        >×</button>
      </div>
    </div>
    <input
      ref="inputEl"
      :value="value"
      :placeholder="placeholderText"
      id="my_search_input"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="onKeyup"
      @paste="onPaste"
    />
    <div class="logo-wrapper">
      <!-- 叶子 logo：**始终显示**（更新提示不再顶掉它，只是叠一个小箭头） -->
      <button
        id="logoButton"
        :title="logoTitle"
        @click="onLogoClick"
        @contextmenu="onLogoContextMenu"
      >
        <img :src="LOGO_ICON" draggable="false" alt="logo" />
      </button>
      <!-- 下载完成、可安装时：叶子右下角显示纯红向上箭头（点击穿透到叶子=安装） -->
      <UpdateBadge v-if="updateReady" />
    </div>
  </div>
</template>
