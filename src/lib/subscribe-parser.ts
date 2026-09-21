/**
 * 订阅解析器 - 我的搜索桌面版
 * 移植自油猴脚本"我的搜索"（v7.9.5，作者 zhuangjie）
 *
 * 负责：
 * 1. tis 标签解析（<tis::URL 属性 />）
 * 2. fetchFun 双标签解析（<fetchFun name="xxx">...</fetchFun>）
 * 3. 数据项提取函数（mLineFetchFun / sLineFetchFun）
 * 4. default-tag 处理、转义/恢复
 */

import { parseTag, parseTags, captureRegEx } from "./tags.ts";
import type { SearchItem, SubscribeItem } from "../types/index.ts";
import { warn, debug } from "./logger";

export { parseTag, parseTags };

/** 单标签解析结果（<tis::URL ... />） */
export interface DesignatedSingTag {
  tabName: string;
  tabValue: string;
  [attribute: string]: string;
}

/** 双标签解析结果 */
export interface DoubleTagEntry {
  attrValue: string;
  tabValue: string;
}

// ========== tis 单标签解析 ==========
/**
 * 解析文本中所有指定名称的单标签（还原 PageTextHandleChains.parseAllDesignatedSingTags）
 * 例：<tis::https://xxx/index.ms title="xx" />
 */
export function parseAllDesignatedSingTags(
  pageText: string,
  parseTabName: string
): DesignatedSingTag[] {
  const regex = /<(\w+)::([\S]+)(.*?)\/>/g;
  const attributesRegex = /([\w-]+)="(.*?)"/g;
  const result: DesignatedSingTag[] = [];
  let matches: RegExpExecArray | null;

  while ((matches = regex.exec(pageText)) !== null) {
    const tabName = matches[1];
    const tabValue = matches[2];
    const attributesString = matches[3];
    if (tabName !== parseTabName) continue;

    const attributes: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    attributesRegex.lastIndex = 0;
    while ((attrMatch = attributesRegex.exec(attributesString)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }
    result.push({ tabName, tabValue, ...attributes });
  }
  return result;
}

// ========== fetchFun 双标签解析 ==========
/**
 * 解析双标签，取指定属性（还原 parseDoubleTab）
 * 例：<fetchFun name="mLineFetchFun">function(text){...}</fetchFun>
 */
export function parseDoubleTab(pageText: string, tabName: string, attrName: string): DoubleTagEntry[] {
  const regex = new RegExp(
    `<\\s*${tabName}[^<>]*\\s*${attrName}="([^<>]*)"\\s*>([\\s\\S]*?)<\\/\\s*${tabName}\\s*>`,
    "gm"
  );
  let m: RegExpExecArray | null;
  const arr: DoubleTagEntry[] = [];
  while ((m = regex.exec(pageText)) !== null) {
    if (m.index === regex.lastIndex) regex.lastIndex++;
    arr.push({ attrValue: m[1], tabValue: m[2] });
  }
  return arr;
}

/**
 * 从订阅标签文本中提取所有 tis 订阅链接（还原 parseTis）
 */
export function parseTis(bodyText: string | null | undefined): string[] {
  const regex = /(<\s*tis::http[^<>]+\/\s*>)/gm;
  const raw = captureRegEx(regex, String(bodyText ?? ""));
  if (raw == null) return [];
  return raw.map((item) => item[1]);
}

/**
 * 将旧版结构化订阅数组迁移为 tis 原文
 * 旧版存储：`[{url, title, describe, fetchFun, defaultTag}, ...]`
 */
export function subscribeItemsToText(items: SubscribeItem[] | null | undefined): string {
  if (!Array.isArray(items)) return "";
  return items
    .filter((it) => it && it.url)
    .map((it) => {
      const attrs: string[] = [];
      if (it.title) attrs.push(`title="${it.title}"`);
      if (it.describe) attrs.push(`describe="${it.describe}"`);
      if (it.fetchFun) attrs.push(`fetchFun="${it.fetchFun}"`);
      if (it.defaultTag) attrs.push(`default-tag="${it.defaultTag}"`);
      return `<tis::${it.url}${attrs.length ? " " + attrs.join(" ") : ""} />`;
    })
    .join("\n");
}

/**
 * 将 tis 元信息数组重新序列化为文本（还原 rebuildTags）
 */
export function rebuildTags(tagMetaArr: DesignatedSingTag[] = []): string {
  return tagMetaArr
    .map((tag) => {
      const { tabName, tabValue, ...attributes } = tag;
      const attributesString = Object.entries(attributes)
        .map(([key, value]) => `${key}="${value}"`)
        .join(" ");
      return `<${tabName}::${tabValue} ${attributesString} />`;
    })
    .join("\n");
}

// ========== URL 工具 ==========
/**
 * 解析相对路径（相对当前订阅文件）
 */
export function resolveUrl(baseUrl: string, relativePath: string): string {
  try {
    return new URL(relativePath, baseUrl).href;
  } catch (e) {
    return relativePath;
  }
}

// ========== 转义 / 恢复（还原 CallBeforeParse） ==========
const ESCAPE_MAP: Record<string, string> = {
  "`": "<反引号>",
  "\\": "<转义>",
  $: "<美元符>",
};

/** 解析前转义 */
export function escapeText(text: string | null | undefined): string {
  let t = String(text ?? "");
  // 剥离 UTF-8 BOM（Windows/PowerShell 常见），避免标题行首被占据
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const key of Object.keys(ESCAPE_MAP)) {
    t = t.split(key).join(ESCAPE_MAP[key]);
  }
  return t;
}

/** 解析后恢复 */
export function recoveryText(text: string | null | undefined): string {
  let t = String(text ?? "");
  for (const key of Object.keys(ESCAPE_MAP)) {
    t = t.split(ESCAPE_MAP[key]).join(key);
  }
  return t;
}

/** 恢复数据项中的字段（还原 contentRecovery） */
export function contentRecovery(item: SearchItem): void {
  item.title = recoveryText(item.title as string);
  item.desc = recoveryText(item.desc as string);
  item.resource = recoveryText(item.resource as string);
  if (item.vassal != null) item.vassal = recoveryText(item.vassal);
}

/**
 * default-tag 处理（还原 defaultTagHandle）
 * tisMetaInfo['default-tag'] = h'游戏' -> 若标题尚未含该标签，则加 [h'游戏']
 */
export function defaultTagHandle(
  item: SearchItem,
  tisMetaInfo: Record<string, string | undefined> = {}
): void {
  const defaultTag = tisMetaInfo["default-tag"];
  if (!defaultTag) return;
  const processedDefaultTag = `[${defaultTag}]`;
  const parsed = parseTag(processedDefaultTag);
  const defaultTagContent = parsed[0] ? parsed[0][3] : null;
  if (!defaultTagContent) return;
  const already = parseTag(item.title).some((meta) => meta[3] === defaultTagContent);
  if (!already) {
    item.title = processedDefaultTag + (item.title ?? "");
  }
}

// ========== 数据项提取函数 ==========
/** 快捷链接信息 */
export interface LinkInfo {
  text: string;
  url: string;
  title: string;
}

/** 链接提取（还原 extractLinkInfo） */
function extractLinkInfo(str: string): LinkInfo | null {
  const regex = /\[(.*?)\]\((https?:\/\/[^\s]+)\s*(?:\s+"([^"]+)?")?\s*\)/;
  const match = str.match(regex);
  if (match) {
    return { text: match[1], url: match[2], title: match[3] || "" };
  }
  return null;
}

/** 是否仅链接行（还原 isOnlyLinkLine） */
function isOnlyLinkLine(str: string | null | undefined): boolean {
  return !String(str ?? "")
    .split("\n")
    .some((line) => line.trim() !== "" && !line.trim().startsWith("> "));
}

/** 是否空白（还原 isBlank） */
function isBlank(str: string | null | undefined): boolean {
  const trimmedStr = String(str ?? "").replace(/\s+/g, "").replace(/[\n\r]+/g, "");
  return trimmedStr === "";
}

/**
 * 「附加内容」分隔线判定：
 * 独占一行、行首最多 3 个空格缩进、3 个及以上短横线、行尾可有空白或 `\r`。
 *
 * 为什么必须是「行首 ≤3 个空格」：
 * 分隔线本质上属于 Markdown，渲染后等价于 <hr>，缩进 4 个空格以上就成了代码块；
 * 官方订阅现有分隔线最多缩进 3 个空格（实际为 0），而 `view:js` 里
 * 模板块（prompt）内的 `---...---` 则缩进 6~8 个空格。
 * 用「行首 ≤3 空格」而不是原版的「任意空白（含制表符）」或
 * 「必须顶格」，可以同时满足：
 * - 不误判脚本项里缩进 4+ 的模板块分隔线（否则脚本源码会被截断，
 *   `view:js` 变成半截代码 → 打开脚本应用时 SyntaxError →
 *   「脚本视图运行出错，已显示其 HTML 内容。」）
 * - 兼容订阅作者用少量缩进书写的分隔线（宽松兼容，不丢附加内容）
 *
 * 另：不使用 `g` 标志。原版正则带 `g` 且复用同一个字面量，`lastIndex` 会跨行累积，
 * 导致判定结果依赖调用次数（同样一行有时算分隔线、有时不算），行为不可预期。
 *
 * 末尾允许一个换行符（`\n?`）：mLineFetchFun 内部按 `\n` split 后不会出现，
 * 但其它按行校验的场景（如测试、外部调用）传入整行原文时应兼容 CRLF/LF 结尾。
 * 注意 JS 的 `$`（无 m 标志）不匹配末尾 `\n` 之前的位置，必须显式处理。
 */
const VASSAL_SEPARATOR_REGEX = /^[ \t]{0,3}-{3,}[ \t\r]*\n?$/;

/**
 * mLineFetchFun - 多行内容提取函数
 *
 * 格式：
 * # 标题(描述)
 * 主要内容行...
 * ----                （独占一行，3 个及以上短横线，行首最多 3 个空格；之后为附加内容）
 * 附加内容 / 快捷链接
 *
 * 注意：分隔线在原文里既用于「简述内容 / 附加内容」分界，也用于脚本应用的
 * `view:js` 等分段（`-- view:js --` 等），因此判定必须精确，否则脚本项会被截断。
 */
export function mLineFetchFun(pageText: string | null | undefined): SearchItem[] {
  const type = "sketch"; // url / sketch
  const lines = String(pageText ?? "").split("\n");
  const search_data_lines: SearchItem[] = [];
  let current_build_search_item: SearchItem = {};
  let appendTarget = "resource";
  let current_build_search_item_resource = "";
  let current_build_search_item_vassal = "";
  let current_build_search_item_links: LinkInfo[] = [];
  let point = 0;
  let inCode = false;
  const default_desc = "--无描述--";

  function getTitleLineData(titleLine: string): { title: string; desc: string } | null {
    const regex = /^#\s*([^（(]+)(?:[（(](.*)[）)])?\s*$/;
    const matchData = regex.exec(titleLine);
    if (!matchData) return null;
    return {
      title: matchData[1],
      desc: matchData[2] == null || matchData[2] === "" ? default_desc : matchData[2],
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 围栏代码块切换：当行以 ``` 开头时切换 inCode 状态
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
    }

    // 在代码块内部不将 # 开头行解析为新的数据项标题
    if (!inCode && line.indexOf("# ") === 0) {
      point++;
      current_build_search_item = { ...(getTitleLineData(line) ?? {}) };
      current_build_search_item_resource = "";
      continue;
    }
    if (point === 0) continue;

    if (VASSAL_SEPARATOR_REGEX.test(line)) {
      appendTarget = "vassal";
      continue;
    }

    // 没有「# 标题」的散落正文（数据项之外的内容，如 dataSource 不完整时的脏数据）忽略
    if (current_build_search_item == null) continue;

    if (appendTarget === "resource") {
      current_build_search_item_resource += line + "\n";
    } else {
      if (
        isOnlyLinkLine(current_build_search_item_vassal) &&
        line.trim().length > 0 &&
        isOnlyLinkLine(line)
      ) {
        const linkInfo = extractLinkInfo(line);
        if (linkInfo) current_build_search_item_links.push(linkInfo);
      } else {
        current_build_search_item_vassal += line + "\n";
      }
    }

    const nextLine = lines[i + 1];
    if (i === lines.length - 1 || (!inCode && nextLine != null && nextLine.indexOf("# ") === 0)) {
      current_build_search_item.resource = current_build_search_item_resource;
      if (!isBlank(current_build_search_item_vassal)) {
        current_build_search_item.vassal = current_build_search_item_vassal;
      }
      if (current_build_search_item_links.length > 0) {
        current_build_search_item.links = current_build_search_item_links;
      }
      search_data_lines.push(current_build_search_item);
      appendTarget = "resource";
      current_build_search_item_resource = "";
      current_build_search_item_vassal = "";
      current_build_search_item_links = [];
    }
  }

  for (const line of search_data_lines) {
    line.type = type;
  }
  return search_data_lines;
}

/**
 * sLineFetchFun - 单行内容提取函数
 * 格式：标题(描述)：资源   或   标题：资源
 */
export function sLineFetchFun(pageText: string | null | undefined): SearchItem[] {
  const type = "url";
  const lines = String(pageText ?? "").split("\n");
  const search_data_lines: SearchItem[] = [];

  for (const line of lines) {
    const search_data_line = (function (line: string): SearchItem | null {
      const baseReg = /([^:：\n(（）)]+)[(（]([^()（）]*)[)）]\s*[:：]\s*(.+)/;
      const ifNotDescMatchReg = /([^:：]+)\s*[:：]\s*(.*)/;
      let title = "";
      let desc = "";
      let resource = "";
      let captureResult: RegExpExecArray | null = null;
      if (!/[()（）]/.test(line)) {
        captureResult = ifNotDescMatchReg.exec(line);
        if (captureResult == null) return null;
        title = captureResult[1];
        desc = "-暂无描述信息-";
        resource = captureResult[2];
      } else {
        captureResult = baseReg.exec(line);
        if (captureResult == null) return null;
        title = captureResult[1];
        desc = captureResult[2];
        resource = captureResult[3];
      }
      return { title, desc, resource };
    })(line);

    if (search_data_line == null || search_data_line.title == null) continue;
    search_data_line.type = type;
    search_data_lines.push(search_data_line);
  }
  return search_data_lines;
}

/** 数据源配置（还原 getConfigFromDataSource） */
export interface DataSourceConfig {
  fetchFuns: Array<{ name: string; fetchFun: string }>;
  tis: DesignatedSingTag[];
}

/**
 * 解析数据源配置（还原 getConfigFromDataSource）
 * - fetchFuns: 自定义提取函数
 * - tis: 子订阅引用
 */
export function getConfigFromDataSource(pageText: string | null | undefined): DataSourceConfig {
  const text = String(pageText ?? "");
  const fetchFunTabDatas = parseDoubleTab(text, "fetchFun", "name");
  const fetchFuns = fetchFunTabDatas.map((d) => ({
    name: d.attrValue,
    fetchFun: d.tabValue,
  }));
  const tis = parseAllDesignatedSingTags(text, "tis");
  return { fetchFuns, tis };
}

/**
 * 解析脚本项 resource：按 `-- 名称 --` 分段（还原 scriptTextParser）
 * 例：
 *   -- env --
 *   _icon xxx
 *   -- script --
 *   function(obj){...}
 *   -- view:html --
 *   <div>...</div>
 */
export function scriptTextParser(text: string | null | undefined): Record<string, string> | null {
  if (text == null) return null;
  const scriptLines = String(text).split("\n");
  if (scriptLines.length === 0) return null;
  const result: Record<string, string> = {};
  let key: string | null = null;
  let value: string | null = null;
  for (let i = 0; i < scriptLines.length; i++) {
    const line = scriptLines[i];
    const captureArr = captureRegEx(/^--\s*([^-\s]*)\s*--\s*$/gm, line);
    const isStartNewVar = captureArr != null && captureArr[0] != null && captureArr[0].length >= 2;
    const isLastLine = i + 1 === scriptLines.length;
    if (isStartNewVar) {
      if (key != null) result[key] = String(value).trim();
      key = captureArr[0][1];
      value = "";
    } else {
      value = (value ?? "") + "\n" + line;
    }
    if (isLastLine) {
      if (key != null) result[key] = String(value).trim();
      return result;
    }
  }
  return result;
}

/**
 * 解析脚本项 env（还原 extractVariables）
 * "aa bb" -> { aa: "bb" }，布尔/数值自动转换
 */
export function extractVariables(varsString: string | null | undefined): Record<string, unknown> {
  const lines = String(varsString ?? "").split("\n");
  const result: Record<string, unknown> = {};
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2) {
      const key = parts[0].trim();
      const value = parts[1].trim();
      if (value === "true" || value === "false") {
        result[key] = value === "true";
      } else if (!isNaN(Number(value)) && value !== "") {
        result[key] = parseFloat(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * 脚本项处理（还原 parseScriptItem）
 * 标题中含 [脚本] / [script] 的数据项转为 type="script"，
 * 解析 resourceObj，并提取自定义 icon 与 vassal。
 */
export function parseScriptItem(searchData: SearchItem[]): SearchItem[] {
  for (const item of searchData) {
    if (item == null || item.title == null || item.type !== "sketch") continue;
    if (!/\[\s*(.*')?\s*(脚本|script)\s*'?\s*\]/.test(item.title)) continue;
    item.type = "script";
    item.resourceObj = scriptTextParser(item.resource) as Record<string, string> | undefined;
    item.resource = "--脚本项resource已解析到resourceObj--";
    if (item.resourceObj && item.resourceObj.env != null) {
      (item.resourceObj as Record<string, unknown>).env = extractVariables(item.resourceObj.env);
      const env = item.resourceObj.env as unknown as Record<string, unknown>;
      const customIcon = env._icon;
      if (customIcon != null) item.icon = String(customIcon);
      const vassal = item.resourceObj.vassal;
      if (vassal != null) item.vassal = vassal;
    }
  }
  return searchData;
}

/** 提取函数签名（mLineFetchFun / sLineFetchFun / 自定义编译版） */
export type FetchFun = (text: string | null | undefined) => SearchItem[];

/** 自定义 fetchFun 描述 */
export interface CustomFetchFun {
  name: string;
  fetchFun: string;
}

/**
 * 根据提取函数名获取实现
 * - 支持内置实现
 * - 支持订阅中自定义的 fetchFun 字符串（动态编译）
 */
export function getFetchFunByName(name: string, globalFetchFun: CustomFetchFun[] = []): FetchFun {
  if (name === "mLineFetchFun") return mLineFetchFun;
  if (name === "sLineFetchFun") return sLineFetchFun;
  if (!name) return mLineFetchFun;

  // 自定义提取函数（来自数据源配置的 <fetchFun>）
  const found = globalFetchFun.find((f) => f.name === name);
  if (found) {
    try {
      // 还原：new Function('text', "return ( " + fetchFunStr + " )(`" + escape(text) + "`)")(text)
      const fn = new Function("text", "return ( " + found.fetchFun + " )(text)") as (
        t: unknown
      ) => SearchItem[];
      return (text) => fn(text);
    } catch (e) {
      warn(`[订阅解析] 自定义提取函数编译失败 (${name}):`, e);
      debug(`回退到默认 mLineFetchFun:`, e);
      // 编译失败回退到默认实现
    }
  }
  return mLineFetchFun;
}
