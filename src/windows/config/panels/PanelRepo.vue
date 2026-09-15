<script setup lang="ts">
/**
 * 公共仓库面板（原 panes.repo + paneBinders.repo）。
 * 提交我的订阅到 TisHub / 打开 Tis 订阅市场 / 清理 Token。
 */
import { onMounted, ref, watch } from "vue";
import { openExternal } from "../../../lib/tauri-bridge";
import { TISHUB_REPO, tokenVersion } from "../configShared";
import type { GithubApi, TisHubApi } from "../useGithub";
import type { SubscribeDraftApi } from "../useSubscribeDraft";

const props = defineProps<{
  github: GithubApi;
  tisHub: TisHubApi;
  draft: SubscribeDraftApi;
  notify: (text: string, type?: "ok" | "error") => void;
  confirm: (text: string) => Promise<boolean>;
  alert: (text: string) => Promise<boolean>;
  askToken: () => Promise<string | null>;
  /** 打开订阅市场 */
  openTisHub: () => void;
}>();

/** 可提交订阅数（null = 尚未计算） */
const commitableCount = ref<number | null>(null);
/** Token 是否已缓存（决定「清理 Token」按钮显隐） */
const hasToken = ref(false);

/** 刷新 Token 状态与可提交数 */
async function refreshViewState(): Promise<void> {
  hasToken.value = props.github.getToken() != null;
  try {
    const tisList = await props.tisHub.getTisHubAllTis();
    commitableCount.value = props.tisHub.tisFilter(props.draft.state.draft, tisList).length;
  } catch (e) {
    commitableCount.value = null;
  }
}

/** 清理 Token */
function clearToken(): void {
  props.github.clearToken();
  hasToken.value = false;
}

/** 提交我的订阅到 TisHub 公共仓库 */
async function pushTis(): Promise<void> {
  if (!(await props.confirm("是否确认要提交到TisHub公共仓库？"))) return;
  if (commitableCount.value == null || commitableCount.value === 0) {
    await props.alert("经过与TisHub中订阅的比较，本地没有可提交的订阅！");
    return;
  }
  const token = await props.github.requestToken();
  if (token == null) {
    await props.alert("获取token失败，无法继续！");
    return;
  }
  try {
    const userInfo = (await props.github.getUserInfo()) as { name?: string } | null;
    if (userInfo == null) throw new Error("请检查网络或提交的Token不可用！");
    const tisList = await props.tisHub.getTisHubAllTis();
    const commitable = props.tisHub.tisFilter(props.draft.state.draft, tisList) || [];
    const { parseAllDesignatedSingTags } = await import("../../../lib/subscribe-parser");
    for (const singleTisText of commitable) {
      const tisMetaInfo = parseAllDesignatedSingTags(String(singleTisText), "tis")[0];
      if (tisMetaInfo == null) continue;
      await props.github.commitIssues({
        title: tisMetaInfo.title || `${userInfo.name}的订阅`,
        body: singleTisText,
      });
    }
    await props.alert("提交成功(issues)！感谢您的参与，脚本因你而更加精彩。");
    await refreshViewState();
  } catch (e) {
    await props.alert(`提交异常！原因：${(e as Error).message}`);
  }
}

onMounted(() => {
  void refreshViewState();
});

// Token 变更时（通过 TokenDialog 提交 / 清理 Token 按钮）刷新面板状态，
// 替代原版 onTokenChanged 回调（组件销毁后回调无效）。
watch(() => tokenVersion.v, () => {
  void refreshViewState();
});

defineExpose({ refreshViewState });

function openRepoLink(e: MouseEvent): void {
  e.preventDefault();
  void openExternal(TISHUB_REPO);
}
</script>

<template>
  <section class="page repo">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>公共仓库</h3>
        <span class="cfg-hint">TisHub 是一个开源订阅仓库，订阅以 Issues 方式共享</span>
      </div>
      <div class="cfg-btn-row">
        <button id="pushTis" class="cfg-btn primary" @click="pushTis">
          提交我的订阅到 TisHub <span class="badge submitable">{{ commitableCount ?? "-" }}</span>
        </button>
        <button id="openTisHub" class="cfg-btn" @click="props.openTisHub()">Tis 订阅市场</button>
        <button
          v-show="hasToken"
          id="clearToken"
          class="cfg-btn ghost"
          @click="clearToken"
        >
          清理 Token
        </button>
      </div>
      <div class="cfg-note">
        提交订阅需要 GitHub Token，仅缓存在本地；Token 失效或需要更换时，可先点击「清理 Token」后重试。
        <a :href="TISHUB_REPO" :data-ext="TISHUB_REPO" class="cfg-hub-link" @click="openRepoLink"
          >打开 TisHub 仓库 ↗</a
        >
      </div>
    </div>
  </section>
</template>
