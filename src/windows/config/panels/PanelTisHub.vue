<script setup lang="ts">
/**
 * 订阅市场面板（原 panes."tis-hub" + paneBinders."tis-hub"）。
 *
 * - 关键字搜索（已安装 / 市场订阅 两个分段）
 * - 结果列表：每行一条订阅（安装 / 移除按钮 + 标题外链）
 * - 返回公共仓库
 */
import { computed, onMounted, ref } from "vue";
import { openExternal } from "../../../lib/tauri-bridge";
import { escapeAttr, escapeHtml } from "../../../lib/util";
import { parseAllDesignatedSingTags } from "../../../lib/subscribe-parser";
import { TISHUB_LOGO, TISHUB_REPO, tisHubState } from "../configShared";
import type { TisHubApi } from "../useGithub";
import type { InstalledTis, InstalledListApi } from "../useInstalledList";

const props = defineProps<{
  tisHub: TisHubApi;
  installed: InstalledListApi;
  notify: (text: string, type?: "ok" | "error") => void;
  /** 返回公共仓库 */
  goRepo: () => void;
}>();

/** 关键字输入（跨面板持久化，原版 config.js:913-920） */
const keyword = computed({
  get: () => tisHubState.keyword,
  set: (v) => { tisHubState.keyword = v; },
});
/** 分段（跨面板持久化） */
const mode = computed({
  get: () => tisHubState.mode,
  set: (v) => { tisHubState.mode = v; },
});
/** 是否加载中 */
const isLoading = ref(true);
/** 加载失败提示（空串 = 无错误） */
const errorText = ref("");
/** 结果列表 */
const results = ref<InstalledTis[]>([]);

function stateAsName(tisState: string): string {
  return (
    (tisState === "disable" && "移除（未启用）") ||
    (tisState === "enable" && "移除") ||
    "安装"
  );
}

/** 重新搜索（进入面板 / 关键字变化 / 分段切换 / 回到窗口时调用） */
async function search(): Promise<void> {
  const kw = keyword.value.trim();
  isLoading.value = true;
  errorText.value = "";
  results.value = [];

  // 已安装：本地过滤
  let list: InstalledTis[] = props.installed.list().filter(
    (item) => kw === "" || item.name.includes(kw)
  );

  if (mode.value === "market") {
    try {
      const marketResult: InstalledTis[] = (
        await props.tisHub.getClosedIssuesTis({ keyword: kw })
      ).map((hubTisInfo) => ({
        name: hubTisInfo.title,
        describe: hubTisInfo.describe ?? "",
        body: hubTisInfo.tisList.join("\n") || "",
        state: "installable",
      }));
      const installedMap = props.installed.list().reduce<Record<string, InstalledTis>>((map, item) => {
        map[item.name] = item;
        return map;
      }, {});
      list = marketResult;
      list.forEach((hubTis) => {
        if (installedMap[hubTis.name]) hubTis.state = installedMap[hubTis.name].state;
      });
    } catch (e) {
      errorText.value = `市场订阅加载失败：${escapeHtml((e as Error).message)}`;
      isLoading.value = false;
      return;
    }
  }

  isLoading.value = false;
  // 无内容：什么都不显示（不出现「没有找到相关订阅」提示）
  results.value = list;
}

/** 取一条结果的 tis 元信息（标题 / 描述 / 地址） */
function metaOf(tis: InstalledTis): Record<string, string> {
  return (parseAllDesignatedSingTags(String(tis.body || ""), "tis")[0] || {}) as Record<
    string,
    string
  >;
}

/** 结果行描述文案（还原原版 fallback 顺序） */
function describeOf(tis: InstalledTis): string {
  const meta = metaOf(tis);
  return meta.describe || tis.describe || "订阅没有描述信息，请确认订阅安全或信任后再安装！";
}

/** 安装 / 移除 */
function toggleInstall(tis: InstalledTis): void {
  const installedItem = props.installed.findByName(tis.name);
  if (installedItem != null) {
    // 移除
    props.installed.remove(installedItem);
    tis.state = "installable";
  } else {
    // 安装
    if (!tis.body) {
      props.notify("该订阅内容为空，无法安装。", "error");
      return;
    }
    props.installed.install(tis);
    tis.state = "enable";
  }
  props.notify("订阅已更新，主窗口会自动重新加载。", "ok");
}

function openLink(e: MouseEvent, url: string): void {
  e.preventDefault();
  if (url) void openExternal(url);
}

onMounted(() => {
  void search();
});

defineExpose({ search });
</script>

<template>
  <section class="page tis-hub">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <button id="backHome" class="cfg-back" title="返回公共仓库" @click="props.goRepo()">
          ← 返回
        </button>
        <h3>订阅市场</h3>
        <a
          :href="TISHUB_REPO"
          :data-ext="TISHUB_REPO"
          class="cfg-hub-link"
          title="TisHub 是一个 GitHub 仓库，订阅以 Issues 的方式存在"
          @click="openLink($event, TISHUB_REPO)"
          >TisHub ↗</a
        >
      </div>
      <div class="hub-search">
        <img class="hub-logo" :src="TISHUB_LOGO" alt="TisHub" />
        <div class="keyword">
          <input
            name="keyword"
            v-model="keyword"
            placeholder="输入关键字，回车搜索…"
            @keydown.enter="search()"
          />
          <button id="search-tishub" @click="search()">搜索</button>
        </div>
      </div>
      <div class="search-type segmented">
        <label :class="{ on: mode === 'installed' }">
          <input type="radio" name="search-type" value="installed" v-model="mode" @change="search()" />
          <span>已安装</span>
        </label>
        <label :class="{ on: mode === 'market' }">
          <input type="radio" name="search-type" value="market" v-model="mode" @change="search()" />
          <span>市场订阅</span>
        </label>
      </div>
    </div>
    <div class="result-list">
      <div class="list-rol">
        <div v-if="isLoading" class="loading">加载中…</div>
        <template v-else-if="errorText">
          <div class="loading" v-html="errorText"></div>
        </template>
        <template v-else>
          <div v-for="tis in results" :key="tis.name" class="hub-tis">
            <div class="tis-info">
              <a
                class="title"
                :href="metaOf(tis).tabValue || TISHUB_REPO"
                :data-ext="metaOf(tis).tabValue || ''"
                target="_blank"
                @click="openLink($event, metaOf(tis).tabValue || TISHUB_REPO)"
                >{{ tis.name }}</a
              >
              <span class="describe">{{ describeOf(tis) }}</span>
            </div>
            <button class="tis-button" :data-name="escapeAttr(tis.name)" @click="toggleInstall(tis)">
              {{ stateAsName(tis.state) }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
