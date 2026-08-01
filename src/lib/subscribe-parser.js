/**
 * 订阅解析器 - 我的搜索桌面版
 * 移植自油猴脚本"我的搜索"（v7.9.5，作者 zhuangjie）
 *
 * 负责：
 * 1. 解析 tis 标签（<tis::URL 属性 />）
 * 2. 递归拉取订阅内容（相对路径解析）
 * 3. mLineFetchFun/sLineFetchFun 提取函数解析数据项
 */

// ---------- tis 标签解析 ----------
/**
 * 解析文本中所有指定名称的单标签
 * 例：<tis::https://xxx/index.ms title="xx" describe="yy" />
 * @param {string} pageText
 * @param {string} parseTabName
 * @returns {Array<{tabName, tabValue, ...attributes}>}
 */
export function parseAllDesignatedSingTags(pageText, parseTabName) {
  const regex = /<(\w+)::([\S]+)(.*?)\/>/g;
  const attributesRegex = /([\w-]+)="(.*?)"/g;
  const result = [];
  let matches;

  while ((matches = regex.exec(pageText)) !== null) {
    const tabName = matches[1];
    const tabValue = matches[2];
    const attributesString = matches[3];
    if (tabName !== parseTabName) continue;

    const attributes = {};
    let attrMatch;
    while ((attrMatch = attributesRegex.exec(attributesString)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }
    result.push({ tabName, tabValue, ...attributes });
  }
  return result;
}

// ---------- URL 工具 ----------
/**
 * 解析相对路径（订阅文件中相对路径相对于该订阅所在位置）
 * @param {string} baseUrl 当前订阅文件 URL
 * @param {string} ref 相对引用路径
 */
export function resolveUrl(baseUrl, ref) {
  try {
    return new URL(ref, baseUrl).href;
  } catch (e) {
    return ref;
  }
}

// ---------- 内容提取函数 ----------
/**
 * mLineFetchFun - 多行内容提取函数
 * 解析 markdown 风格的数据文件：
 * # 标题(描述)
 * 内容行...
 * ----
 * 附加内容
 * @param {string} pageText
 * @returns {Array} 数据项数组
 */
export function mLineFetchFun(pageText) {
  let type = "sketch"; // url / sketch
  let lines = pageText.split("\n");
  let search_data_lines = [];
  let current_build_search_item = {};
  let appendTarget = "resource";
  let current_build_search_item_resource = "";
  let current_build_search_item_vassal = "";
  let current_build_search_item_links = [];
  let point = 0;
  let default_desc = "--无描述--";

  function extractLinkInfo(str) {
    const regex = /\[(.*?)\]\((https?:\/\/[^\s]+)\s*(?:\s+"([^"]+)?")?\s*\)/;
    const match = str.match(regex);
    if (match) {
      return { text: match[1], url: match[2], title: match[3] || "" };
    }
    return null;
  }

  function isOnlyLinkLine(str) {
    return !str
      .split("\n")
      .some((line) => line.trim() !== "" && !line.trim().startsWith("> "));
  }

  function getTitleLineData(titleLine) {
    try {
      const regex = /^#\s*([^（(]+)(?:[（(](.*)[）)])?\s*$/;
      const matchData = regex.exec(titleLine);
      return {
        title: matchData[1],
        desc: matchData[2] == null || matchData[2] === "" ? default_desc : matchData[2],
      };
    } catch (e) {
      console.log("提取函数工作时遇到了问题:", e);
    }
  }

  function isBlank(str) {
    const trimmedStr = str.replace(/\s+/g, "").replace(/[\n\r]+/g, "");
    return trimmedStr === "";
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.indexOf("# ") === 0) {
      point++;
      current_build_search_item = { ...getTitleLineData(line) };
      current_build_search_item_resource = "";
      continue;
    }
    if (point === 0) continue;

    if (/^\s*-{3,}\s*$/gm.test(line)) {
      appendTarget = "vassal";
      continue;
    }

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

    let nextLine = lines[i + 1];
    if (i === lines.length - 1 || (nextLine != null && nextLine.indexOf("# ") === 0)) {
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

  for (let line of search_data_lines) {
    line.type = type;
  }
  return search_data_lines;
}

/**
 * sLineFetchFun - 单行内容提取函数（简单格式）
 * @param {string} pageText
 */
export function sLineFetchFun(pageText) {
  let lines = pageText.split("\n");
  let search_data_lines = [];
  let current = null;

  for (let line of lines) {
    if (line.trim() === "") continue;
    // # 标题(描述)
    if (line.indexOf("# ") === 0) {
      const regex = /^#\s*([^（(]+)(?:[（(](.*)[）)])?\s*$/;
      const m = regex.exec(line);
      if (m) {
        current = {
          title: m[1],
          desc: m[2] == null || m[2] === "" ? "--无描述--" : m[2],
          resource: "",
          type: "sketch",
        };
        search_data_lines.push(current);
      }
      continue;
    }
    if (current) {
      current.resource += line + "\n";
    }
  }
  return search_data_lines;
}

/**
 * 根据提取函数名获取实现
 */
export function getFetchFunByName(name) {
  if (name === "mLineFetchFun") return mLineFetchFun;
  if (name === "sLineFetchFun") return sLineFetchFun;
  return mLineFetchFun; // 默认
}
