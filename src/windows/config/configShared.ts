/**
 * 配置窗口共享常量与订阅原文读写（与主窗口/搜索引擎共享 localStorage 键）。
 */
import { parseAllDesignatedSingTags, rebuildTags, subscribeItemsToText } from "../../lib/subscribe-parser";
import { storageGet, storageSet } from "../../lib/util";
import type { SubscribeItem } from "../../types/index";
import { reactive } from "vue";

// ========== 存储键（与主窗口/搜索引擎保持一致） ==========
/** 订阅原文（tis 文本），主窗口从这里加载 */
export const SUBSCRIBES_KEY = "subscribes";
/** 用户维护的不关注标签列表 */
export const UNFOLLOW_KEY = "USER_UNFOLLOW_LIST_CACHE_KEY";
/** 数据项标签统计（由主窗口写入） */
export const TAGS_KEY = "DATA_ITEM_TAGS_CACHE_KEY";
/** 数据缓存（与搜索引擎 SEARCH_DATA_KEY 一致）：主窗口写入，这里可清理 */
export const SEARCH_DATA_KEY = "SEARCH_DATA_KEY";
/** 订阅列表指纹（与搜索引擎一致）：清理缓存时一并清除 */
export const SUBSCRIBE_FINGERPRINT_KEY = "SUBSCRIBE_FINGERPRINT_CACHE_KEY";
/** 已安装的 TisHub 订阅 */
export const TISHUB_KEY = "USE_INSTALL_TISHUB_CACHE_KEY";
/** GitHub Token */
export const TOKEN_KEY = "USER_GITHUB_TOKEN_CACHE_KEY";
/** 默认不关注的标签 */
export const DEFAULT_UNFOLLOW = ["成人内容", "Adults only"];
/** 默认全局呼出快捷键（与 Rust 端 DEFAULT_TOGGLE_SHORTCUT 一致） */
export const DEFAULT_TOGGLE_SHORTCUT = "ctrl+alt+s";

export const TISHUB_LOGO = "https://cdn.jsdelivr.net/gh/My-Search/TisHub/favicon.ico";
export const TISHUB_REPO = "https://github.com/My-Search/TisHub";

/** 读取订阅原文（兼容旧版结构化数组） */
export function getSubscribe(): string {
  const saved = storageGet<string | SubscribeItem[] | null>(SUBSCRIBES_KEY, null);
  // 兼容旧版结构化数组
  if (Array.isArray(saved)) {
    const text = subscribeItemsToText(saved);
    storageSet(SUBSCRIBES_KEY, text);
    return text;
  }
  if (typeof saved === "string" && saved.trim() !== "") return saved;
  return "";
}

/** 写入订阅文本并返回有效 tis 数量（还原 editSubscribe） */
export function editSubscribe(subscribe: string): number {
  const tisArr = parseAllDesignatedSingTags(String(subscribe ?? ""), "tis");
  const subscribeText = "\n" + rebuildTags(tisArr) + "\n";
  const newSubscribeInfo = subscribeText.replace(/\n+/gm, "\n\n");
  storageSet(SUBSCRIBES_KEY, newSubscribeInfo);
  return tisArr.length;
}

/** 订阅条块（订阅总览里的一条） */
export interface SubscribeRow {
  /** 在原订阅原文中的序号 */
  index: number;
  name: string;
  describe: string;
  url: string;
  /** 还原后的单条 tis 文本（编辑/删除时按 tabValue 定位） */
  body: string;
}

/** 从订阅原文解析出条块列表 */
export function parseSubscribeItems(rawText: string): SubscribeRow[] {
  return parseAllDesignatedSingTags(rawText, "tis").map((tis, index) => ({
    index,
    name: tis.title || tis.tabValue,
    describe: tis.describe || "",
    url: tis.tabValue,
    body: rebuildTags([tis]),
  }));
}

/** 用条块列表重建订阅原文（逐条 rebuildTags 后换行拼接，保持两行分隔的存储格式） */
export function subscribeItemsToRawText(items: Array<Pick<SubscribeRow, "body">>): string {
  return items.map((it) => it.body).join("\n\n");
}

/** 字节数转可读文案（原 config.js 的 formatBytes） */
export function formatBytes(bytes: unknown): string {
  const n = Math.max(0, Math.round(Number(bytes) || 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * TisHub 市场的跨面板持久化状态。
 * 原版（config.js:913-920）将 tisHubInput / tisHubMode 保存在全局 state 中，
 * 切换面板再回来原样恢复。Vue 组件切换时销毁重建，因此将搜索态提到这里。
 */
export const tisHubState = reactive({
  keyword: "",
  mode: "installed" as "installed" | "market",
});

/**
 * Token 版本号：每次 Token 变更（写入/清理）时自增。
 * PanelRepo 通过 watch 此值来刷新视图，解决组件销毁重建无法接收回调的问题。
 */
export const tokenVersion = reactive({ v: 0 });
