<script setup lang="ts">
/**
 * 详情视图（原 #text_show）：简述内容 / 附加内容 / 脚本视图。
 *
 * - 简述/附加内容：v-html 渲染 markdown（Vue 托管 DOM，禁止手工 innerHTML 覆盖
 *   同级 v-if 节点，否则下一次 patch 会 insertBefore(null) 崩溃）
 * - 脚本视图：v-if 渲染一个 .script-view 容器，内容由 useScriptHost 注入
 *   （脚本内容本身是「原生 DOM 写入」，只在容器内部操作，不影响 Vue 的 vdom）
 * - 高度自适应由 useDetailHeight 提供（ResizeObserver + 窗口高度下发）
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { escapeHtml, md2html, scrollToText } from "../../lib/util";
import { useDetailHeight } from "./useDetailHeight";
import type { SearchItem } from "../../types/index";

/** 详情视图内容：文本型（brief/vassal）或脚本型 */
export interface DetailContent {
  kind: "text" | "script";
  title: string;
  /** desc 作为正文左侧标签文案 */
  desc: string;
  /** 文本型正文（markdown 源码） */
  body: string;
  /** 脚本型：数据项（useScriptHost 挂载用） */
  item?: SearchItem;
}

const props = defineProps<{
  visible: boolean;
  content: DetailContent | null;
  /** 搜索关键词（用于详情内容里的关键词定位） */
  keyword: string;
}>();

/** 详情高度控制（实测 #my_search_box 高度后原样下发，保证下边框贴窗口底边） */
const detailHeight = useDetailHeight();

const textView = ref<HTMLElement | null>(null);
const scriptHost = ref<HTMLElement | null>(null);

const isScript = computed(() => props.content?.kind === "script");

/** 文本型内容的 HTML（标题行 + markdown 正文） */
const bodyHtml = computed(() => {
  const c = props.content;
  if (!c || c.kind !== "text") return "";
  return (
    `<div class="text-head"><span class="text-label">标题</span>：${escapeHtml(c.title)}<br/>` +
    `<span class="text-label">${escapeHtml(c.desc)}</span></div>` +
    `<div id="ms-page-body" class="markdown-body">${md2html(c.body)}</div>`
  );
});

/** 挂载代码块右上角复制按钮（还原原版 codeCopyMount） */
function codeCopyMount(elementSelector: string): void {
  document.querySelectorAll(`${elementSelector} .markdown-body pre code`).forEach((codeBlock) => {
    // 跳过已挂载的
    const pre = codeBlock.parentElement;
    if (!pre || pre.querySelector(".copy-btn")) return;
    // 创建复制按钮
    const copyButton = document.createElement("button");
    copyButton.innerText = "复制";
    copyButton.className = "copy-btn";
    // 复制代码逻辑
    copyButton.addEventListener("click", () => {
      const text = (codeBlock as HTMLElement).innerText || codeBlock.textContent || "";
      navigator.clipboard
        .writeText(text)
        .then(() => {
          copyButton.innerText = "已复制";
          setTimeout(() => (copyButton.innerText = "复制"), 2000);
        })
        .catch((err) => {
          console.error("复制失败:", err);
        });
    });
    // <pre> 相对定位，按钮放右上角
    (pre as HTMLElement).style.position = "relative";
    pre.appendChild(copyButton);
  });
}

/** 文本型内容渲染完成后的收尾（复制按钮 + 高度 + 关键词定位） */
async function afterTextRendered(): Promise<void> {
  const owner = textView.value;
  if (!owner) return;
  codeCopyMount("#text_show");
  await nextTick();
  detailHeight.attach(owner);
  detailHeight.fit();
  detailHeight.flush();
  // 关键词定位（还原 scrollToText）：仅简述/附加内容
  const keyword = props.keyword.trim();
  if (keyword.length > 1) {
    setTimeout(() => scrollToText(keyword, document.getElementById("ms-page-body")), 60);
  }
}

/** 脚本视图挂载完成后启用高度自适应（由 App 在 mountScriptView 回调里调用） */
function onScriptMounted(): void {
  const owner = textView.value;
  if (!owner) return;
  detailHeight.attach(owner);
  detailHeight.fit();
  detailHeight.flush();
}

watch(
  () => props.content,
  async (c) => {
    if (!c || !props.visible) return;
    if (c.kind === "text") {
      await nextTick();
      await afterTextRendered();
    } else {
      detailHeight.detach();
    }
  },
  { flush: "post", immediate: true }
);

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      const c = props.content;
      if (!c) return;
      if (c.kind === "text") {
        await nextTick();
        await afterTextRendered();
      }
    } else {
      detailHeight.detach();
    }
  },
  { flush: "post" }
);

defineExpose({
  /** 强制重新应用内容（如窗口呼出原样还原时） */
  reapply: async () => {
    const c = props.content;
    if (!c) return;
    if (c.kind === "text") {
      await nextTick();
      await afterTextRendered();
    } else {
      onScriptMounted();
    }
  },
  /** 脚本视图挂载完成回调 */
  onScriptMounted,
  fitHeight: detailHeight.fit,
  flushHeight: detailHeight.flush,
  resetHeightCache: detailHeight.resetCache,
  /** #text_show 元素（脚本样式需挂在它下面，与原版 cssFillPrefix 一致） */
  owner: textView,
});

onBeforeUnmount(() => {
  detailHeight.detach();
});
</script>

<template>
  <div
    id="text_show"
    class="ms-markdown-body"
    ref="textView"
    :style="{ display: props.visible ? 'block' : 'none' }"
  >
    <!-- 脚本视图容器：内容由 useScriptHost 注入（view:html / view:css / view:js） -->
    <div v-if="isScript" ref="scriptHost" class="script-view"></div>
    <!-- 简述内容 / 附加内容：Vue 托管 v-html（禁止手工覆盖，避免破坏 vdom） -->
    <div v-else v-html="bodyHtml"></div>
  </div>
</template>
