/**
 * 搜索数据的存储键与时长常量（**零依赖**）。
 *
 * 为什么单独拆一个文件：
 * 这些键既被搜索主窗口用，也被**设置窗口**用（插件面板要读 `SEARCH_DATA_KEY`
 * 里的数据项来投影旧版 `[脚本]` 项；缓存面板要显示/清理缓存）。
 * 而 `search-engine.ts` 依赖 `pinyin-pro`（约 400KB）——设置窗口的设计前提是
 * 「不加载搜索引擎/巨型依赖」（见 `src/config.ts` 的文件头注释）。
 *
 * 之前插件面板直接从 `search-engine.ts` 导入 `SEARCH_DATA_KEY`，把整个引擎和
 * pinyin-pro 拖进了设置窗口：模块图从 ~10 个变成 48 个请求，挂载耗时从毫秒级
 * 涨到 7 秒以上，撞上 `config.html` 里 8 秒的兜底计时器，表现为
 * 「页面加载失败，请重启应用」。
 *
 * 因此：**凡是只需要键名/时长的地方，都从这里导入**，不要碰 search-engine。
 */

/** 缓存键：加载完成的全部数据项 + 过期时间（还原油猴版 SEARCH_DATA_KEY） */
export const SEARCH_DATA_KEY = "SEARCH_DATA_KEY";

/** 上一次加载的数据项 id 集合（还原油猴版 OLD_SEARCH_DATA_KEY） */
export const OLD_SEARCH_DATA_KEY = "OLD_SEARCH_DATAS_KEY";

/** 数据有效期（还原 effectiveDuration：12 小时） */
export const EFFECTIVE_DURATION = 1000 * 60 * 60 * 12;

/** 订阅列表指纹（用于判断订阅是否变化，变化则立即失效缓存） */
export const SUBSCRIBE_FINGERPRINT_KEY = "SUBSCRIBE_FINGERPRINT_CACHE_KEY";
