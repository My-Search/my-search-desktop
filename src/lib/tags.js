/**
 * 标签（tag）处理 - 我的搜索桌面版
 * 移植自油猴脚本"我的搜索"（v7.9.5）
 *
 * 数据项标题形如：[精选好课] 恋上数据结构与算法
 * 其中 [精选好课] 是标签，[h'游戏'] 表示隐藏标签（不显示，仅用于分类/取消关注）
 */

/** 标签颜色映射（还原 titleTagColorMatchHandler） */
const TAG_COLORS = {
  系统项: "background:rgb(0,210,13);",
  非最佳: "background:#fbbc05;",
  推荐: "background:#ea4335;",
  装机必备: "background:#9933E5;",
  好物: "background:rgb(247,61,3);",
  安卓应用: "background:#73bb56;",
  "Adults only": "background:rgb(244,201,13);",
  可搜索: "background:#4c89fb;border-radius:0px !important;",
  新: "background:#f70000;",
  最新一条: "background:#f70000;",
  精选好课: "background:#221109;color:#fccd64 !important;",
};

/**
 * 捕获正则的所有匹配（还原 captureRegEx）：返回 [[完整匹配, 组1, 组2, ...], ...]
 */
export function captureRegEx(regex, text) {
  const result = [];
  if (regex == null || text == null) return result;
  let m;
  const re = regex.global
    ? regex
    : new RegExp(regex.source, regex.flags + "g");
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++;
    result.push(Array.from(m));
  }
  return result;
}

/**
 * 解析标题中的所有标签（还原 parseTag）
 * 返回数组，每项为 [完整, 参数, 参数?, 标签名]
 * 例："[h'游戏']标题" -> [["[h'游戏']", "h", undefined, "游戏"]]
 */
export function parseTag(title) {
  return captureRegEx(/\[\s*(([^'\]\s]*)\s*')?\s*([^'\]]*)\s*'?\s*]/gm, String(title ?? ""));
}

/**
 * 解析标签并汇总（还原 parseTags）
 * @returns {Array<{name,status,count}>}
 */
export function parseTags(data = [], selecterFun = (item) => item, tagsMap = {}) {
  const isArray = Array.isArray(data);
  const items = isArray ? data : [data];
  items.forEach(function (item) {
    const captureGroups = parseTag(selecterFun(item));
    captureGroups.forEach(function (group) {
      const label = group[3];
      if (label != null && tagsMap[label] == null) {
        tagsMap[label] = { name: label, status: 1, count: 1 };
      } else if (tagsMap[label] != null) {
        tagsMap[label].count++;
      }
    });
  });
  return Object.values(tagsMap);
}

/** 获取标签颜色（还原 titleTagColorMatchHandler） */
export function titleTagColor(tagValue) {
  return TAG_COLORS[tagValue] || "background:#5eb95e;";
}

/**
 * 将标题中的标签渲染为彩色 span（还原 titleTagHandler）
 * @param {string} titleHtml 已做 HTML 转义的标题
 */
export function titleTagHandler(titleHtml) {
  const regex = /(\[[^\[\]]*\])/gm;
  let m;
  let resultTitle = titleHtml;
  while ((m = regex.exec(titleHtml)) !== null) {
    if (m.index === regex.lastIndex) regex.lastIndex++;
    const tag = m[0];
    if (!tag) continue;
    const tagCore = tag.substring(1, tag.length - 1);
    resultTitle = resultTitle.split(tag).join(
      `<span style="${titleTagColor(tagCore)}" class="flag">${tagCore}</span>`
    );
  }
  return resultTitle;
}

/**
 * 还原 registry.view.titleTagHandler.execute：
 * 只取标题开头的标签（最多到最后一个 `]`）并渲染为彩色 span，返回的仅是标签部分，
 * 标题正文由 titleContentHandler 另行渲染，两者拼接后即为完整标题。
 * @param {string} titleHtml 已做 HTML 转义的标题
 */
export function renderTitleTags(titleHtml) {
  const arr = String(titleHtml ?? "").match(/\[.*\]/);
  if (!arr || !arr[0]) return "";
  return titleTagHandler(arr[0].trim());
}

/**
 * 去掉隐藏标签，如 [h'游戏']（还原 clearHideTagForTitle）
 */
export function clearHideTagForTitle(rawTitle) {
  const regex = /\[\s*[^:\]]*h[^:\]]*\s*'\s*[^'\]]*\s*'\s*]/gm;
  return String(rawTitle ?? "").replace(regex, "");
}

/**
 * 提取所有标签并清理内容（还原 extractTagsAndCleanContent）
 * @returns {{tags: string[], cleaned: string}}
 */
export function extractTagsAndCleanContent(inputString = "") {
  const regex = /\[.*?\]/g;
  const tags = inputString.match(regex) || [];
  const cleaned = inputString.replace(regex, "").trim();
  return { tags, cleaned };
}

/**
 * 标题渲染处理器（还原 titleContentHandler）
 * - 去掉所有 [xxx] 标签
 * - 以 # 开头的标题加删除线（obsolete）
 */
export function titleContentHandler(title) {
  const { cleaned } = extractTagsAndCleanContent(title);
  const safe = String(cleaned ?? "");
  return `<span class="item_title ${safe.startsWith("#") ? "obsolete" : ""}">${safe.replace(/^#/, "")}</span>`;
}
