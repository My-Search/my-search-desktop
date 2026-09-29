/**
 * 附件 chip 的**系统文件图标**（资源管理器同款：Word 文档显示 Word 图标）。
 *
 * 为什么单独一个模块：搜索框 chips 与「最近添加」条带都要用同一套图标，
 * 而两处是不同组件（SearchBox.vue / App.vue）。做成模块级共享缓存后，
 * 同一批文件只查一次、两个组件都命中同一份 data URL，不重复走 IPC。
 *
 * 三层职责：
 *   1. **模块级缓存**（`iconCache`）：路径 → data URL，跨组件跨重挂载存活；
 *   2. **在途去重**（`pending`）：同一批路径并发请求只发一次 IPC；
 *   3. **响应式版本号**（`fileIconVersion`）：异步拿到图标后通知 Vue 重渲染。
 *
 * 失败即回退：取不到图标的条目（旧宿主没有该命令、非 Windows、Shell 查不到）
 * 不进缓存也不报错，调用方按 `iconOf()` 返回空串走内置 SVG 图标。
 */
import { ref, type Ref } from "vue";
import { attachmentFileIcons } from "../../lib/plugins/ipc.ts";
import type { AttachedEntry } from "../../lib/plugins/attachments";

/** 附件 → 缓存键。前端这份按**完整路径**存（Rust 侧已按类型去重过 Shell 查询，
 *  这里只是避免同一路径在 chips 与条带之间反复问）。无路径的条目（web 层兜底、
 *  剪贴板位图）没有系统图标可取，返回空串由调用方跳过。 */
function keyOf(entry: Pick<AttachedEntry, "path">): string {
  return String(entry.path ?? "").trim();
}

/** 路径 → PNG data URL（模块级，跨组件共享） */
const iconCache = new Map<string, string>();
/** 正在请求中的路径（避免并发重复发 IPC） */
const pending = new Set<string>();

/**
 * 缓存版本号：异步图标到达时 +1，驱动所有使用它的组件重渲染。
 * 用模块级 ref 而不是每组件一份，是为了让两个组件共用同一次通知。
 */
export const fileIconVersion = ref(0);

/** 同步读一个附件的系统图标；未就绪/取不到时返回空串（调用方走内置图标） */
export function fileIconOf(entry: Pick<AttachedEntry, "path">): string {
  const key = keyOf(entry);
  return key ? iconCache.get(key) ?? "" : "";
}

/**
 * 为一批附件预取系统图标（幂等：已缓存/在途的路径跳过）。
 *
 * 调用时机：附件列表变化时（chips 与条带都会各自调一次，靠 pending 去重）。
 * 不 await 也能用——拿到后经 `fileIconVersion` 通知重渲染。
 */
export function prefetchFileIcons(entries: readonly AttachedEntry[]): void {
  const want = (entries ?? []).filter((e) => {
    if (!e) return false;
    const k = keyOf(e);
    return k !== "" && !iconCache.has(k) && !pending.has(k);
  });
  if (want.length === 0) return;

  // 按路径去重后一次性发给 Rust（Rust 侧还会按类型再合并一次 Shell 查询）
  const seen = new Set<string>();
  const req: { path: string; isDir: boolean }[] = [];
  for (const e of want) {
    const p = keyOf(e);
    if (seen.has(p)) continue;
    seen.add(p);
    req.push({ path: p, isDir: e.kind === "folder" });
  }
  if (req.length === 0) return;

  const paths = req.map((r) => r.path);
  for (const p of paths) pending.add(p);

  void attachmentFileIcons(req)
    .then((map) => {
      let changed = false;
      for (const [path, dataUrl] of map) {
        if (!iconCache.has(path)) {
          iconCache.set(path, dataUrl);
          changed = true;
        }
      }
      if (changed) fileIconVersion.value++;
    })
    .finally(() => {
      // 失败/未命中的路径也解除在途标记：下次列表变化时可以再试一次
      //（比如文件当时还没就绪，稍后就有了）
      for (const p of paths) pending.delete(p);
    });
}

/**
 * 附件列表变化时清理失效缓存（避免随会话无限增长）。
 *
 * **调用方必须传「全部还活着的条目」的并集**：chips 与「最近添加」条带
 * 共享这一份缓存，而条带里的条目恰恰是「还没进输入框」的那些——只看
 * 输入框里的附件去裁剪，会把条带正在用的图标一起清掉（下次展开条带又要
 * 重新走一遍 IPC）。所以由同时持有两份状态的 App.vue 调用，传并集。
 */
export function pruneFileIcons(alive: readonly AttachedEntry[]): void {
  if (iconCache.size === 0) return;
  // 容忍 null（附件被清空时调用方可能直接传空值）
  const keep = new Set((alive ?? []).map(keyOf).filter(Boolean));
  for (const k of [...iconCache.keys()]) {
    if (!keep.has(k)) iconCache.delete(k);
  }
}

/** 组件里用的便捷封装：返回响应式的取图标函数（图标到达后自动重渲染） */
export function useFileIcons(): {
  /** 取一个附件的系统图标（空串 = 未就绪/取不到，调用方走内置图标） */
  iconOf: (entry: Pick<AttachedEntry, "path">) => string;
  /** 预取一批附件的图标（幂等） */
  prefetch: (entries: readonly AttachedEntry[]) => void;
  /** 版本号（模板里读一下就建立依赖，图标到达后自动刷新） */
  version: Ref<number>;
} {
  return {
    iconOf: (entry) => {
      // 读一次版本号：让调用方的渲染建立对图标的依赖
      void fileIconVersion.value;
      return fileIconOf(entry);
    },
    prefetch: prefetchFileIcons,
    version: fileIconVersion,
  };
}
