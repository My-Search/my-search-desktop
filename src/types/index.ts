/**
 * 共享类型定义 - 我的搜索桌面版
 *
 * 这里收敛两个窗口（搜索主窗口 / 配置窗口）与 lib 层之间的公共数据结构，
 * 避免各文件重复声明、也便于 IDE 跳转。
 */

/* ============================================================
 * 订阅 / 数据项
 * ============================================================ */

/** 订阅条目（由 <tis::… /> 解析而来） */
export interface SubscribeItem {
  /** 订阅地址（index.ms 的 URL），对应 tis 的 tabValue */
  url: string;
  /** 订阅名（缺省取地址） */
  title?: string;
  /** 订阅描述 */
  describe?: string;
  /** 自定义抓取函数名（订阅文本里的 fetch-fun 属性） */
  fetchFun?: string;
  /** 默认标签（default-tag 属性） */
  defaultTag?: string;
}

/** 解析后的单条 tis 标签结构（parseAllDesignatedSingTags 的产物） */
export interface TisMeta {
  /** 标签名，如 "tis" */
  tagName?: string;
  /** 主值（订阅地址） */
  tabValue: string;
  /** 属性表 */
  attrs?: Record<string, string>;
  title?: string;
  describe?: string;
  fetchFun?: string;
  "default-tag"?: string;
  [key: string]: unknown;
}

/** 数据项（订阅内容源里的一条记录） */
export interface SearchItem {
  /** 在 engine.searchData 中的下标（部分临时项才有） */
  index?: number;
  /** 标题（可能含 [标签]） */
  title?: string;
  /** 描述 */
  desc?: string;
  /** 资源：URL 或简述文本 */
  resource?: string;
  /** 附加内容（相关联/同类项） */
  vassal?: string;
  /** 快捷链接 */
  links?: Array<{ url: string; title: string; text: string }>;
  /** 数据项类型：url / sketch / script */
  type?: string;
  /** 自定义图标（脚本项） */
  icon?: string;
  /** 脚本项的 { script, view:html, view:css, view:js } 等 */
  resourceObj?: Record<string, string>;
  /** 运行时派生的索引字段（搜索引擎写入，不写入缓存） */
  _titleUpper?: string;
  _descUpper?: string;
  _titlePinyin?: string;
  _titlePinyinShort?: string;
  _resourceUpper?: string;
  _descPinyin?: string;
  _contentUpper?: string;
  _cleanedTitleUpper?: string;
  _descTagsUpper?: string;
  /** 数据项所属订阅名（loadSubscribe 写入） */
  subscribe?: string;
  /** 其余由订阅内容源附加的字段 */
  [key: string]: unknown;
}

/** 搜索结果包装（含匹配层级与分数） */
export interface SearchResult {
  item: SearchItem;
  /** 匹配层级（越高越精确） */
  level: number;
  /** 匹配分数 */
  score?: number;
}

/* ============================================================
 * 标签
 * ============================================================ */

/** 标签统计条目 */
export interface TagStat {
  name: string;
  count?: number;
  /** 1=关注，0=不关注 */
  status?: number;
}

/* ============================================================
 * 版本更新
 * ============================================================ */

/** 更新检查结果（Rust check_update 返回值） */
export interface UpdateInfo {
  has_update: boolean;
  latest_version: string;
  current_version: string;
  download_url: string;
  release_url: string;
}

/** 更新下载进度事件载荷 */
export interface UpdateProgress {
  downloaded: number;
  total: number;
  percent: number;
  status: string;
  error?: string;
}

/** 更新下载完成事件载荷 */
export interface UpdateCompletePayload {
  path: string;
}

/* ============================================================
 * Tauri 桥接
 * ============================================================ */

/** 通用 HTTP 请求选项 */
export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** 字符串原样发送，其余 JSON 序列化 */
  body?: string | object | null;
}

/** raw.githubusercontent.com URL 的解析结果 */
export interface RawGithubUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

/* ============================================================
 * TisHub / GitHub
 * ============================================================ */

/** TisHub 市场里的一条订阅（来自 GitHub Issues） */
export interface TisHubEntry {
  owner: string;
  ownerProfile: string;
  title: string;
  /** 描述（市场条目可能是从 tis 属性里补的，可选） */
  describe?: string;
  tisList: string[];
  status: string;
}

/** 已安装订阅记录 */
export interface InstalledSubscribe {
  name: string;
  describe: string;
  body: string;
  state: string;
}

/* ============================================================
 * 视图模式
 * ============================================================ */

/** 视图模式枚举（搜索主窗口） */
export const MODE = {
  WAIT_SEARCH: 0,
  SHOW_RESULT: 1,
  SHOW_ITEM_DETAIL: 2,
} as const;

export type ModeEnum = typeof MODE;
export type ModeValue = (typeof MODE)[keyof typeof MODE];
