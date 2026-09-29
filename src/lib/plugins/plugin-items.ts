/**
 * 插件贡献的搜索数据项合成 —— 纯函数。
 *
 * 插件在结果列表里的表现形式必须与订阅数据项**完全一致**（同一套渲染、
 * 同一套标签、同一套点击加权），否则「插件」会变成界面上的第二套物种。
 * 因此这里把插件贡献合成为标准 SearchItem，只在内部携带 `_pluginId` 标记，
 * 供宿主在 openItem 时分流到插件视图。
 *
 * 与订阅数据项的两处关键差异（刻意的）：
 *   1. `subscribe` 写成 `插件：<name>`，让用户一眼看出条目来源不是订阅；
 *   2. **不写入 SEARCH_DATA_KEY 缓存**（缓存带订阅指纹，掺入插件项会破坏
 *      既有的「订阅变化即失效」逻辑），改由加载时重新合成。
 */

import type { SearchItem } from "../../types/index.ts";
import { listSearchItems, type PluginManifest } from "./manifest.ts";
import { isInlineIconRef } from "./icon.ts";
import type { PluginRecord } from "./registry.ts";

// 图标引用的判定与解析集中在 icon.ts（设置面板与搜索窗口必须一致），
// 这里原样再导出一次，纯粹为了让既有导入路径继续可用。
export { isInlineIconRef, iconDataUrl, iconMimeOf, iconRefsOf } from "./icon.ts";

/** 插件项的标记字段（宿主内部使用，不写入缓存） */
export const PLUGIN_ITEM_FLAG = "_pluginId";
/** 插件项「参与二次搜索」的标记字段（清单 contributes.searchItem.subSearch 的运行时投影） */
export const PLUGIN_SUB_SEARCH_FLAG = "_pluginSubSearch";
/** 来源标记：结果列表里显示为「插件：xxx」 */
export const PLUGIN_SUBSCRIBE_PREFIX = "插件：";

/** 一个插件项在结果里的稳定性（用于排序/去重）：插件 id + 关键词 */
export function pluginItemKey(pluginId: string, keyword: string): string {
  return `${pluginId}::${keyword}`;
}

/** 合成单个插件的搜索项（未启用 / 未声明时返回空数组） */
export function buildPluginItems(
  record: PluginRecord,
  /**
   * 图标解析器（可选）：把清单里的图标引用转成可直接用于 <img src> 的值。
   *
   * 插件目录内的**相对路径图标**（如 `icon.png`）需要宿主读文件转成 data URL——
   * 这是异步的，而本函数是同步的，因此由调用方（usePluginHost）预先解析好、
   * 通过这个回调按引用取用；取不到时返回 undefined，条目会退回默认图标。
   *
   * `data:` / `http(s):` 这类自带完整地址的引用不需要解析，原样返回即可。
   */
  resolveIcon?: (iconRef: string) => string | undefined
): SearchItem[] {
  if (!record.enabled) return [];
  const list = listSearchItems(record.manifest);
  if (list.length === 0) return [];
  return list
    .filter((it) => it.visible !== false)
    .map((it) => {
      // 条目自身没写图标时，退回插件清单的顶层 icon（作者通常只写一处）
      const rawIcon = it.icon ?? record.manifest.icon;
      const icon = rawIcon == null ? undefined : isInlineIconRef(rawIcon) ? rawIcon : resolveIcon?.(rawIcon);
      const item: SearchItem = {
        title: it.title,
        desc: it.desc ?? record.description ?? "",
        resource: it.resource ?? "",
        type: "script", // 复用脚本项的渲染与打开路径（点击 = 打开视图）
        icon,
        subscribe: PLUGIN_SUBSCRIBE_PREFIX + record.name,
      };
      // 标记 + 关键词：宿主据此渲染插件视图、以及把「关键词 : 子词」转发给插件
      item[PLUGIN_ITEM_FLAG] = record.id;
      item._pluginKeyword = it.keyword;
      // 参与二次搜索的声明：只有它为 true，宿主才会补 `[可搜索]` 标记
      // （补标记 = 进入 PRO 模式候选，见 search-engine 的 _indexItem）
      item[PLUGIN_SUB_SEARCH_FLAG] = it.subSearch === true;
      return item;
    });
}

/** 合成所有启用插件的搜索项 */
export function buildAllPluginItems(
  records: readonly PluginRecord[],
  resolveIcon?: (pluginId: string, iconRef: string) => string | undefined
): SearchItem[] {
  const out: SearchItem[] = [];
  for (const r of records) {
    out.push(...buildPluginItems(r, resolveIcon ? (ref) => resolveIcon(r.id, ref) : undefined));
  }
  return out;
}

/** 取数据项所属的插件 id（非插件项返回 null） */
export function pluginIdOf(item: SearchItem | null | undefined): string | null {
  const v = item?.[PLUGIN_ITEM_FLAG];
  return typeof v === "string" && v !== "" ? v : null;
}

/** 取插件项声明的关键词（用于子关键词转发与命令注册） */
export function pluginKeywordOf(item: SearchItem | null | undefined): string | null {
  const v = item?._pluginKeyword;
  return typeof v === "string" && v !== "" ? v : null;
}

/** 该插件项是否声明参与二次搜索（未声明 = false = 不进 PRO 模式候选） */
export function pluginSubSearchOf(item: SearchItem | null | undefined): boolean {
  return item?.[PLUGIN_SUB_SEARCH_FLAG] === true;
}
