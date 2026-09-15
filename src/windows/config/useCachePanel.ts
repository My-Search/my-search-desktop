/**
 * 数据缓存面板的条目定义与清理键集合（从原 config.js 抽出）。
 */
import {
  SEARCH_DATA_KEY,
  SUBSCRIBE_FINGERPRINT_KEY,
  SUBSCRIBES_KEY,
  TAGS_KEY,
  TISHUB_KEY,
  TOKEN_KEY,
  UNFOLLOW_KEY,
} from "./configShared";

/** 单个缓存条目的展示信息 */
export interface CacheEntry {
  key: string;
  label: string;
  desc: string;
  clearable: boolean;
  bytes: number;
  sizeText: string;
  countText: string;
  expired: boolean;
  empty: boolean;
  countdown: boolean;
}

/** 缓存条目定义 */
export interface CacheBlueprintItem {
  key: string;
  label: string;
  desc: string;
  clearable: boolean;
}

/**
 * 缓存条目定义。clearable=true 的缓存属于「可安全重建」，一键清理后主窗口会重新加载；
 * 其余为用户数据（订阅原文、标签偏好等），仅统计占用，不提供一键清理。
 */
export const CACHE_BLUEPRINT: CacheBlueprintItem[] = [
  {
    key: SEARCH_DATA_KEY,
    label: "订阅数据缓存",
    desc: "主窗口加载订阅后的搜索结果缓存，可由订阅重新构建",
    clearable: true,
  },
  {
    key: SUBSCRIBE_FINGERPRINT_KEY,
    label: "订阅指纹",
    desc: "订阅原文指纹，用于判断数据缓存是否已失效",
    clearable: true,
  },
  {
    key: TAGS_KEY,
    label: "标签统计",
    desc: "数据项标签及数量统计，主窗口加载数据时刷新",
    clearable: false,
  },
  {
    key: "ITEM_WEIGHT_CACHE_KEY",
    label: "条目权重",
    desc: "根据你的选择行为累积的排序权重",
    clearable: false,
  },
  {
    key: "HISTORY_CACHE_KEY",
    label: "搜索历史",
    desc: "最近 60 条搜索记录",
    clearable: false,
  },
  {
    key: "SEARCH_NEW_ITEMS_KEY",
    label: "新增条目记录",
    desc: "订阅更新后标记出来的新条目",
    clearable: false,
  },
  {
    key: SUBSCRIBES_KEY,
    label: "订阅原文",
    desc: "「订阅管理」中保存的 <tis::… /> 文本",
    clearable: false,
  },
  {
    key: UNFOLLOW_KEY,
    label: "不关注标签",
    desc: "你在「关注标签」中取消勾选的标签",
    clearable: false,
  },
  {
    key: TISHUB_KEY,
    label: "已安装订阅",
    desc: "TisHub 已安装订阅的本地记录",
    clearable: false,
  },
  {
    key: TOKEN_KEY,
    label: "GitHub Token",
    desc: "用于向 TisHub 提交订阅的 GitHub Token",
    clearable: false,
  },
];

/** 一键清理时移除的缓存键（均可由主窗口重新构建） */
export const CACHE_CLEAR_KEYS = [SEARCH_DATA_KEY, SUBSCRIBE_FINGERPRINT_KEY];

export { SUBSCRIBES_KEY, SEARCH_DATA_KEY, SUBSCRIBE_FINGERPRINT_KEY };
