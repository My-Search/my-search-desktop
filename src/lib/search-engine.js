/**
 * 搜索数据管理核心 - 我的搜索桌面版
 * 移植自油猴脚本"我的搜索"（v7.9.5）
 *
 * 负责：
 * - 订阅数据加载（递归 tis 解析 + 提取函数）
 * - 数据项缓存与索引
 * - 拼音索引
 * - 多级搜索（精确搜索 → 拼音搜索 → 重叠匹配）
 */

import { pinyin } from "pinyin-pro";
import { parseAllDesignatedSingTags, resolveUrl, getFetchFunByName } from "./subscribe-parser.js";
import { overlapMatchingDegreeForObjectArray } from "./overlap.js";
import { httpGet } from "./tauri-bridge.js";

/** 空格占位符（拼音转换时保护空格） */
const SPACE = "<Space>";
const SPACE_CHAR = " ";

/**
 * 搜索数据管理器
 */
export class SearchEngine {
  constructor() {
    /** 全部数据项 */
    this.searchData = [];
    /** 文本→拼音 映射缓存（会话级） */
    this.textPinyinMap = {};
    /** 订阅列表 */
    this.subscribes = [];
    /** 加载状态 */
    this.loading = false;
    /** 已加载的订阅 URL（防止循环） */
    this.loadedUrls = new Set();
  }

  /**
   * 文本转拼音（带缓存）
   * @param {string} text
   * @param {boolean} onlyFromCache 仅查缓存
   */
  toPinyin(text, onlyFromCache = false) {
    if (this.textPinyinMap[text] != null) {
      return this.textPinyinMap[text];
    }
    if (onlyFromCache) return null;
    const safeText = text.replaceAll(SPACE_CHAR, SPACE);
    const pinyinArr = pinyin(safeText, { toneType: "none", type: "array" });
    const result = pinyinArr.join("").replaceAll(SPACE, SPACE_CHAR).toUpperCase();
    this.textPinyinMap[text] = result;
    return result;
  }

  /**
   * 递归加载订阅
   * @param {string} url 订阅 URL
   * @param {object} meta 订阅元信息（title/describe/fetchFun/defaultTag）
   * @param {number} depth 递归深度
   */
  async loadSubscribe(url, meta = {}, depth = 0) {
    if (depth > 6) return; // 防止无限递归
    if (this.loadedUrls.has(url)) return; // 去重
    this.loadedUrls.add(url);

    let text;
    try {
      text = await httpGet(url);
    } catch (e) {
      console.warn(`订阅加载失败: ${url}`, e);
      return;
    }

    // 解析 tis 标签（子订阅引用）
    const tisTags = parseAllDesignatedSingTags(text, "tis");
    if (tisTags.length > 0) {
      for (const tag of tisTags) {
        const childUrl = resolveUrl(url, tag.tabValue);
        await this.loadSubscribe(childUrl, tag, depth + 1);
      }
    }

    // 提取函数解析数据项
    const fetchFunName = meta.fetchFun || "mLineFetchFun";
    const fetchFun = getFetchFunByName(fetchFunName);
    let items = [];
    try {
      items = fetchFun(text);
    } catch (e) {
      console.warn(`提取函数执行失败: ${url}`, e);
    }

    // 补充元信息（默认标签）
    const defaultTag = meta.defaultTag || "";
    for (const item of items) {
      item.subscribe = meta.title || url;
      item.sourceUrl = url;
      if (defaultTag) {
        item.tags = item.tags || [];
        item.tags.push(defaultTag);
      }
      // 构建拼音索引（懒加载：首次搜索时构建）
    }
    this.searchData.push(...items);
  }

  /**
   * 加载所有订阅
   * @param {Array} subscribes 订阅列表 [{url, title, describe, fetchFun, defaultTag}]
   */
  async loadAll(subscribes) {
    this.subscribes = subscribes;
    this.searchData = [];
    this.loadedUrls = new Set();
    this.loading = true;
    try {
      for (const sub of subscribes) {
        await this.loadSubscribe(sub.url, sub, 0);
      }
      console.log(`[我的搜索] 数据加载完成: ${this.searchData.length} 条`);
    } finally {
      this.loading = false;
    }
    return this.searchData;
  }

  /**
   * 重新加载（清理缓存）
   */
  async reload() {
    this.textPinyinMap = {};
    return this.loadAll(this.subscribes);
  }

  /**
   * 精确 + 拼音搜索
   * @param {string} keyword
   * @returns {Array<{item, level}>} level 0=标题命中 1=描述命中
   */
  accurateSearch(keyword) {
    const upperKeyword = keyword.toUpperCase();
    const pinyinKeyword = keyword.length > 1 ? (this.toPinyin(keyword) ?? "") : "";
    const searchLevelData = [[], []];

    for (const item of this.searchData) {
      const title = item.title || "";
      const desc = item.desc || "";
      const titlePinyin = this.toPinyin(title, true);
      const descPinyin = this.toPinyin(desc, true);

      const titleHit =
        title.toUpperCase().includes(upperKeyword) ||
        (pinyinKeyword && titlePinyin && titlePinyin.includes(pinyinKeyword));
      const descHit =
        desc.toUpperCase().includes(upperKeyword) ||
        (pinyinKeyword && descPinyin && descPinyin.includes(pinyinKeyword));

      if (titleHit) searchLevelData[0].push({ item, level: 0 });
      else if (descHit) searchLevelData[1].push({ item, level: 1 });
    }
    return [...searchLevelData[0], ...searchLevelData[1]];
  }

  /**
   * 重叠匹配度搜索（无精确结果时兜底）
   * @param {string} keyword
   */
  fuzzySearch(keyword) {
    const upperKeyword = keyword.toUpperCase();
    const scoreList = [];
    // overlapMatchingDegreeForObjectArray 返回过滤后的数据项数组，
    // scoreList 通过 scopeForObjArrContainer 收集每项的匹配分数（与返回数组同序）
    const matchedItems = overlapMatchingDegreeForObjectArray(
      upperKeyword,
      [...this.searchData],
      (item) => [item.title || "", item.desc || ""],
      { onlyHasScope: true, scopeForObjArrContainer: scoreList }
    );
    return matchedItems.map((item, i) => ({ item, level: 2, score: scoreList[i] }));
  }

  /**
   * 综合搜索（三级）
   * @param {string} keyword
   */
  search(keyword) {
    const kw = (keyword || "").trim();
    if (!kw) return [];

    // 第一级：精确 + 拼音
    const accurate = this.accurateSearch(kw);
    if (accurate.length > 0) {
      return accurate.slice(0, 50);
    }

    // 第二级：重叠匹配度
    const fuzzy = this.fuzzySearch(kw);
    if (fuzzy.length > 0) {
      return fuzzy.slice(0, 50);
    }

    return [];
  }
}
