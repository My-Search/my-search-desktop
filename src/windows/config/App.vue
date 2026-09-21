<script setup lang="ts">
/**
 * 设置窗口根组件（原 config.js 的 renderApp + initInteractions）。
 *
 * 布局（DOM 与原版完全一致）：
 *   #ms-config-view
 *     > header.cfg-header（标题 + GitHub 链接）
 *     > .cfg-main
 *         > aside.cfg-nav（左侧分类菜单）
 *         > main.cfg-body（右侧内容区，动态面板）
 *     > footer.cfg-footer（保存并应用）
 *     > ToastHost / MessageDialog / TokenDialog
 *
 * 面板按需渲染（不保活）：<component :is> 切换，等价原 setPane() 的 innerHTML 替换。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { getDefaultSubscribeText, getShortcutBindings, openExternal } from "../../lib/tauri-bridge";
import { defaultToggleBinding, type ShortcutBinding } from "../../lib/shortcut-bindings";
import { storageGet, storageSet } from "../../lib/util";
import { subscribeItemsToText } from "../../lib/subscribe-parser";
import { useMessageDialog } from "../../composables/useMessageDialog";
import { useToast } from "../../composables/useToast";
import MessageDialog from "../../components/MessageDialog.vue";
import ToastHost from "../../components/ToastHost.vue";
import TokenDialog from "./TokenDialog.vue";
import PanelSubscribes from "./panels/PanelSubscribes.vue";
import PanelTags from "./panels/PanelTags.vue";
import PanelRepo from "./panels/PanelRepo.vue";
import PanelCache from "./panels/PanelCache.vue";
import PanelShortcut from "./panels/PanelShortcut.vue";
import PanelGeneral from "./panels/PanelGeneral.vue";
import PanelAbout from "./panels/PanelAbout.vue";
import PanelTisHub from "./panels/PanelTisHub.vue";
import PanelSync from "./panels/PanelSync.vue";
// 插件面板**延迟加载**：它依赖插件运行时（plugin/ipc/host…），静态引入会把
// 这些模块拖进设置窗口的首屏模块图，冷启动（Vite 首次按需编译）挂载耗时
// 从 ~1.7s 涨到 ~6.9s，逼近 config.html 里 8 秒的兜底计时器，
// 慢机器上就会看到「页面加载失败，请重启应用」。面板本身只在用户点「插件」时才需要。
const PanelPlugins = defineAsyncComponent(() => import("./panels/PanelPlugins.vue"));
import { SUBSCRIBES_KEY } from "./configShared";
import { useSubscribeDraft } from "./useSubscribeDraft";
import { useTagsChecked } from "./useTagsChecked";
import { useInstalledList } from "./useInstalledList";
import { createGithubApi, createTisHub } from "./useGithub";
import { setupBuiltinAutoInstall } from "../../lib/plugins/install-builtin";

/** 面板名 */
type PaneName =
  | "subscribes"
  | "tags"
  | "repo"
  | "cache"
  | "shortcut"
  | "general"
  | "about"
  | "tis-hub"
  | "plugins"
  | "sync";

/** 有内容需要保存的页面：只有这两个页面显示底栏的「保存并应用」按钮 */
const PANES_WITH_SAVE: PaneName[] = ["subscribes", "tags"];

const REPO_URL = "https://github.com/My-Search/my-search-desktop";

// ---------- 跨面板状态 ----------
const draft = useSubscribeDraft();
const tags = useTagsChecked();
const installed = useInstalledList(draft);

const toast = useToast();
const message = useMessageDialog();

// askToken 在下面定义（函数声明提升），token 变化后由面板自行刷新状态
const github = createGithubApi(
  () => askToken(),
  () => {
    /* noop */
  }
);
const tisHub = createTisHub(github);

/** 当前面板（tis-hub 属于「公共仓库」分支，左侧高亮 repo） */
const pane = shallowRef<PaneName>("subscribes");
const navPane = computed<PaneName>(() => (pane.value === "tis-hub" ? "repo" : pane.value));

/** 快捷键绑定（快捷键 / 作用类型 / 作用对象；由「快捷键」面板读写） */
const shortcutBindings = ref<ShortcutBinding[]>([defaultToggleBinding()]);
/** 快捷键录入态（录入时 Esc 不关窗） */
const shortcutCapturing = ref(false);

/** Token 弹窗可见性 */
const tokenVisible = ref(false);
let tokenResolver: ((value: string | null) => void) | null = null;

function askToken(): Promise<string | null> {
  return new Promise((resolve) => {
    tokenResolver = resolve;
    tokenVisible.value = true;
  });
}
function closeAskToken(value: string | null): void {
  tokenVisible.value = false;
  const resolve = tokenResolver;
  tokenResolver = null;
  if (resolve) resolve(value);
}

// 面板组件映射（等价原 panes 字典）
const PANES = {
  subscribes: PanelSubscribes,
  tags: PanelTags,
  repo: PanelRepo,
  cache: PanelCache,
  shortcut: PanelShortcut,
  general: PanelGeneral,
  about: PanelAbout,
  "tis-hub": PanelTisHub,
  plugins: PanelPlugins,
  sync: PanelSync,
} as const;

const currentComponent = computed(() => PANES[pane.value]);

/** 底栏是否显示（仅订阅管理 / 关注标签） */
const showFooter = computed(() => PANES_WITH_SAVE.includes(pane.value));

/** 面板组件实例（用于调用 refreshViewState 等） */
const paneRef = shallowRef<Record<string, unknown> | null>(null);

function switchPane(name: PaneName): void {
  if (pane.value === name) return;
  pane.value = name;
}

/** 保存并应用 */
function onSaveAndApply(): void {
  tags.save();
  const validCount = draft.commit();
  toast.showToast(`保存配置成功！有效订阅数：${validCount}。主窗口会自动重新加载。`, "ok");
  // 重新判断已安装状态
  installed.reload();
  installed.persist();
}

/** 面板切换后（组件挂载）刷新依赖外部状态的面板 */
function onPaneMounted(el: unknown): void {
  paneRef.value = (el as Record<string, unknown>) ?? null;
}

/** 关闭窗口 */
function closeWindow(): void {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch(() => window.close());
}

// ---------- 键盘 ----------
function onGlobalKeydown(e: KeyboardEvent): void {
  // 「快捷键」录入态时按键被录入逻辑独占，这里全部让路
  if (shortcutCapturing.value) return;
  // 确认/提示弹窗优先：Esc=取消，Enter=确定（与原生 confirm 行为一致）。
  // 必须 preventDefault + stopPropagation 阻止焦点按钮的默认 click（否则
  // 弹窗关闭后浏览器会触发仍持有焦点的「删除」「清理缓存」等按钮，产生级联）。
  if (message.state.visible) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      message.handleCancel();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      message.handleOk();
    }
    return;
  }
  if (tokenVisible.value) {
    if (e.key === "Escape") closeAskToken(null);
    return;
  }
  if (e.key === "Escape") closeWindow();
}

function onExtLinkClick(e: MouseEvent): void {
  const a = (e.target as HTMLElement).closest("a[data-ext]") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  if (a.dataset.ext) void openExternal(a.dataset.ext);
}

// ---------- 生命周期 ----------
/**
 * 窗口失焦 / 隐藏时停止缓存面板倒计时，重新获得焦点时恢复。
 * 原版（config.js:1946-1998）在 re-focus 时还会：刷新缓存面板、重检标签签名、
 * 重新搜索市场、刷新仓库徽章。这里用 visibilitychange + focus 实现。
 */
function onWindowFocusRefresh(): void {
  // 刷新标签签名与勾选态（如果主窗口更新了标签统计）
  tags.setSignature(tags.computeSignature());
  tags.load();
  // 刷新已安装列表（对应原版 refreshPaneIfStale）
  installed.reload();
}

function onWindowVisible(): void {
  onWindowFocusRefresh();
  // 通知 TisHub 面板：若组件挂载了会重搜（通过 tisHubState 变化触发 watcher）
}

// 声明为顶层引用，供 addEventListener / removeEventListener 配对使用
const onVisibilityChange = () => {
  if (document.visibilityState === "visible") onWindowVisible();
};
const onFocusRefresh = () => onWindowFocusRefresh();

onMounted(async () => {
  // 键盘监听器在所有 await 之前注册：
  // 否则 Rust invoke 调用较慢时，异步初始化期间按 Esc 会完全没有响应
  document.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onFocusRefresh);

  // 首次运行：写入默认订阅原文（并兼容旧版数组）
  try {
    const saved = storageGet<string | SubscribesArray | null>(SUBSCRIBES_KEY, null);
    if (Array.isArray(saved)) {
      storageSet(SUBSCRIBES_KEY, subscribeItemsToText(saved));
    } else if (typeof saved !== "string" || saved.trim() === "") {
      try {
        const defaults = await getDefaultSubscribeText();
        storageSet(SUBSCRIBES_KEY, defaults);
      } catch (e) {
        console.warn("获取默认订阅失败:", e);
      }
    }
    // 快捷键当前生效值从后端读取（浏览器调试时回退默认值）
    try {
      shortcutBindings.value = await getShortcutBindings();
    } catch (e) {
      console.warn("读取快捷键设置失败:", e);
    }

    draft.init();
    tags.setSignature(tags.computeSignature());
    tags.load();
    installed.reload();
    // 内置插件自动安装（幂等，设置窗第二次打开时同样走一遍确保齐全）
    await setupBuiltinAutoInstall();
  } catch (e) {
    console.error("[我的搜索-设置] 初始化失败:", e);
  }
});

type SubscribesArray = Array<{ url: string; title?: string; describe?: string }>;

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("focus", onFocusRefresh);
  toast.disposeToast();
});

/** 面板传入的通用 props（各面板只取自己需要的） */
const commonProps = computed(() => ({
  draft,
  tags,
  github,
  tisHub,
  installed,
  notify: toast.showToast,
  confirm: (text: string) => message.confirmMessage(text),
  alert: (text: string) => message.alertMessage(text),
  askToken,
  goRepo: () => switchPane("repo"),
  openTisHub: () => switchPane("tis-hub"),
  saved: shortcutBindings.value,
  onSaved: (v: ShortcutBinding[]) => (shortcutBindings.value = v),
  goPlugins: () => switchPane("plugins"),
  onChange: () => {
    /* 订阅文本变化：主窗口下次呼出时会检测并重载 */
  },
  onCapturing: (v: boolean) => (shortcutCapturing.value = v),
}));
</script>

<template>
  <div id="ms-config-view">
    <header class="cfg-header">
      <div class="cfg-title">
        <span class="cfg-logo" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span>设置</span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px">
        <a
          class="cfg-github-link"
          :href="REPO_URL"
          :data-ext="REPO_URL"
          target="_blank"
          title="在 GitHub 上查看源码"
          aria-label="GitHub 仓库"
          @click="onExtLinkClick"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
      </div>
    </header>

    <div class="cfg-main">
      <aside class="cfg-nav">
        <button class="nav-item" :class="{ on: navPane === 'subscribes' }" data-pane="subscribes" @click="switchPane('subscribes')">
          <svg viewBox="0 0 20 20" fill="currentColor" width="17" height="17">
            <path d="M3 3a14 14 0 0 1 14 14h-3A11 11 0 0 0 3 6V3zm0 7a7 7 0 0 1 7 7H7a4 4 0 0 0-4-4v-3zm1 5a2 2 0 1 1 4 0 2 2 0 0 1-4 0z" />
          </svg>
          <span>订阅管理</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'tags' }" data-pane="tags" @click="switchPane('tags')">
          <svg viewBox="0 0 20 20" fill="currentColor" width="17" height="17">
            <path d="M0 0h9.59a2 2 0 0 1 1.41.59l8 8a2 2 0 0 1 0 2.82l-6.59 6.59a2 2 0 0 1-2.82 0l-8-8A2 2 0 0 1 1 8.59V2a2 2 0 0 1 2-2h6.59H0zm4 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
          </svg>
          <span>关注标签</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'repo' }" data-pane="repo" @click="switchPane('repo')">
          <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17">
            <path d="M12.3 1.37a11.5 11.5 0 0 1 5.33 4.35l1.2 1.73 1.09.03a4.5 4.5 0 0 1 3.7 3.78c.38 2.52-1.2 4.9-3.6 5.67l-.2.06H6.33l-.28-.01A6.6 6.6 0 0 1 1.37 9.5c0-3.58 2.73-6.47 6.1-6.48l.18.01.82.02.42-.68A6.92 6.92 0 0 1 12.3 1.37z" />
            <path d="M11.57 9.06H10.2a3.22 3.22 0 0 0-.77-2.33A3.6 3.6 0 0 0 6.54 5.4v-1.5a5.1 5.1 0 0 1 4.14 1.7c.74.78 1.08 1.66 1.17 3.3l-.28.16z" />
          </svg>
          <span>公共仓库</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'cache' }" data-pane="cache" @click="switchPane('cache')">
          <svg viewBox="0 0 20 20" fill="currentColor" width="17" height="17">
            <path d="M2 4.5C2 3.12 5.58 2 10 2s8 1.12 8 2.5v1c0 1.38-3.58 2.5-8 2.5S2 6.88 2 5.5v-1zM2 7.5v1C2 9.88 5.58 11 10 11s8-1.12 8-2.5v-1C18 8.88 14.42 10 10 10S2 8.88 2 7.5zM2 11.5v1c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5v-1c0 1.38-3.58 2.5-8 2.5S2 12.88 2 11.5zM18 14.5c0 1.38-3.58 2.5-8 2.5s-8-1.12-8-2.5v1c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5v-1z" />
          </svg>
          <span>数据缓存</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'shortcut' }" data-pane="shortcut" @click="switchPane('shortcut')">
          <svg viewBox="0 0 20 20" fill="currentColor" width="17" height="17">
            <path d="M2 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5zm3 2v2h2V7H5zm4 0v2h2V7H9zm4 0v2h2V7h-2zM5 11v2h8v-2H5z" />
          </svg>
          <span>快捷键</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'plugins' }" data-pane="plugins" @click="switchPane('plugins')">
          <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17">
            <path d="M4 11a9 9 0 0 1 9 9H4v-9zm0 11h18v2H4v-2zm0-4h12v2H4v-2zm0-4h6v2H4v-2z"/>
            <circle cx="18" cy="4.5" r="3"/>
            <path d="M22 5.5A3.5 3.5 0 1 1 15 4a3.5 3.5 0 0 1 7 1.5z" opacity="0.3"/>
          </svg>
          <span>插件</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'general' }" data-pane="general" @click="switchPane('general')">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="17" height="17">
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4" />
          </svg>
          <span>基础配置</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'sync' }" data-pane="sync" @click="switchPane('sync')">
          <svg viewBox="0 0 20 20" fill="currentColor" width="17" height="17">
            <path d="M9.5 2a7.5 7.5 0 0 1 7.49 7.36A5 5 0 0 1 16.5 19H5A4 4 0 0 1 5 11a5.5 5.5 0 0 1 4.5-9zm0 1.5a4 4 0 0 0-3.95 4.6l.15.78-.72.3A3 3 0 0 0 5 17h11.5a3.5 3.5 0 0 0 .48-6.96l-.74-.12-.07-.77A6 6 0 0 0 9.5 3.5z"/>
            <path d="M10.5 8.5V11h2a.5.5 0 0 1 0 1H10a.5.5 0 0 1-.5-.5V8.5a.5.5 0 0 1 1 0z"/>
          </svg>
          <span>备份与同步</span>
        </button>
        <button class="nav-item" :class="{ on: navPane === 'about' }" data-pane="about" @click="switchPane('about')">
          <svg viewBox="0 0 20 20" fill="currentColor" width="17" height="17">
            <path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm1-11a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-1 3a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0v-3a1 1 0 0 1 1-1z" />
          </svg>
          <span>关于软件</span>
        </button>
      </aside>

      <main class="cfg-body">
        <component
          :is="currentComponent"
          ref="onPaneMounted"
          v-bind="commonProps"
          :key="pane"
        />
      </main>
    </div>

    <!-- 页面层底栏：仅订阅管理 / 关注标签显示「保存并应用」 -->
    <footer class="cfg-footer" :class="{ show: showFooter }">
      <button
        class="btn-save"
        type="button"
        data-role="save"
        title="保存并应用"
        aria-label="保存并应用"
        @click="onSaveAndApply"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </footer>

    <ToastHost :state="toast.state" />
    <TokenDialog :visible="tokenVisible" @ok="(v: string) => closeAskToken(v)" @cancel="closeAskToken(null)" />
    <MessageDialog :state="message.state" @ok="message.handleOk" @cancel="message.handleCancel" />
  </div>
</template>
