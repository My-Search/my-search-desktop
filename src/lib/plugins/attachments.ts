/**
 * 搜索框附件（粘贴 / 拖入的文件与文件夹）—— 纯逻辑。
 *
 * 交互约定（与搜索窗口的实现对应）：
 *   1. 用户把文件或文件夹粘贴 / 拖进搜索框 → 产生 `AttachedEntry[]`；
 *   2. 结果列表**立刻收敛**为「声明了对应处理能力（contributes.handlers）
 *      的插件」贡献的条目——非插件项、无能力插件全部隐去；
 *   3. 用户继续输入 `xxx : yyy`：xxx 只在这些候选里过滤（选择插件），
 *      yyy 经子关键词通道（onSubKeyword）交给插件，由插件决定是否消费。
 *
 * 本文件只放纯函数（可单测、两端可用）；响应式状态与 Rust 同步在
 * App.vue / ipc.ts 里。
 */

import type { SearchItem } from "../../types/index.ts";
import { pluginIdOf } from "./plugin-items.ts";
import { inputHandlersOf } from "./manifest.ts";
import type { PluginRecord } from "./registry.ts";

/** 附件条目：搜索框里粘贴/拖入的一个文件或文件夹 */
export interface AttachedEntry {
  /** 条目类型：文件夹 / 文件 */
  kind: "file" | "folder";
  /** 展示名（文件名 / 文件夹名） */
  name: string;
  /** 绝对路径（web 层拿不到路径时为空串——只影响插件侧读取，不影响过滤） */
  path: string;
  /**
   * 剪贴板位图键（截图 / 浏览器复制的图片等**没有文件路径**的图片）。
   * 指向 clipboard-image.ts 旁挂表里的一份 data URL；仅存活于本次会话，
   * **不得**写入 localStorage（见 mergeRecentAttachments 的剥离）。
   * 有它即表示「这是一张可以直接渲染的图片」，即使 name 没有图片扩展名。
   */
  blobKey?: string;
  /**
   * 「最近添加」历史专用：是否为**固定**条目。
   * 固定条目始终排在条带最前、且不计入 RECENT_ATTACH_CAP 上限（永不被挤掉）。
   * 附件（输入框 chips）不关心此字段——它只属于历史记录。
   */
  pinned?: boolean;
}

/** 附件集合里出现过的类型（用于查询“需不需要 file/folder 能力”） */
export function attachmentKinds(entries: readonly AttachedEntry[]): Set<AttachedEntry["kind"]> {
  const kinds = new Set<AttachedEntry["kind"]>();
  for (const e of entries ?? []) if (e?.kind === "file" || e?.kind === "folder") kinds.add(e.kind);
  return kinds;
}

/** 是否至少附加了一个文件夹 */
export function hasFolder(entries: readonly AttachedEntry[]): boolean {
  return (entries ?? []).some((e) => e?.kind === "folder");
}

/** 唯一键：有路径按路径（大小写不敏感），有 blobKey 按 blobKey，否则退回 名称+类型 */
export function attachmentKey(e: AttachedEntry): string {
  const path = String(e?.path ?? "").trim();
  if (path) return `p:${path.replace(/\\/g, "/").toLowerCase()}`;
  // 剪贴板位图没有路径、常见同名（image.png）：用 blobKey 区分不同截图
  const blobKey = String(e?.blobKey ?? "").trim();
  if (blobKey) return `b:${blobKey}`;
  return `n:${e?.kind ?? ""}:${e?.name ?? ""}`;
}

/**
 * 合并附件（去重、保序：已有在前，新条目追加在后）。
 * 与「粘贴一批、再粘贴一批」以及「同名不同路径都要」的真实用法对齐。
 */
export function mergeAttachments(
  current: readonly AttachedEntry[],
  incoming: readonly AttachedEntry[]
): AttachedEntry[] {
  const out: AttachedEntry[] = [];
  const seen = new Set<string>();
  for (const list of [current ?? [], incoming ?? []]) {
    for (const e of list) {
      if (!e || (e.kind !== "file" && e.kind !== "folder")) continue;
      const key = attachmentKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: e.kind,
        name: String(e.name ?? ""),
        path: String(e.path ?? ""),
        // blobKey 只在会话内存活，但合并必须带上，否则图片过了这步就没了
        ...(e.blobKey ? { blobKey: e.blobKey } : {}),
      });
    }
  }
  return out;
}

/** 「最近添加」历史的 storage 键（storageGet/storageSet 直接使用；进 .msbackup 备份） */
export const RECENT_ATTACH_KEY = "RECENT_ATTACH_KEY";

/** 「最近添加」历史中**未固定**条目的上限（够翻几屏又不肥）。
    固定的条目不计入此上限（见 mergeRecentAttachments）。 */
export const RECENT_ATTACH_CAP = 30;

/**
 * 合并「最近添加」历史（Alt 条带的数据源）：本次新增的条目提到最前，
 * 按 attachmentKey 去重（同一文件反复添加只留最新一份并置顶），
 * **未固定**条目封顶 cap 条；**固定**条目额外保留、不计入上限，且始终排最前。
 *
 * 顺序语义（列表顶部 = 最近一次附加 / 固定的在最前）：
 *   1. 固定条目：按「新增里出现的固定项 → 原有固定项」的顺序，整体置顶；
 *   2. 未固定条目：新增（按传入顺序）在前，其余按原历史顺序；
 *   3. 未固定部分累计到 cap 条即停止（固定条目不受限）。
 *
 * `pinnedSet` 记录本次应视为固定的 key 集合——由调用方从现有历史 +
 * 本次新增里汇总（新增条目一般不带 pinned，其固定态继承历史）。
 */
export function mergeRecentAttachments(
  recent: readonly AttachedEntry[],
  added: readonly AttachedEntry[],
  cap: number = RECENT_ATTACH_CAP,
  pinnedSet?: ReadonlySet<string>
): AttachedEntry[] {
  // 去重后的完整有序列表（新增在前，历史在后），保留各自的 pinned 标记
  const ordered: AttachedEntry[] = [];
  const seen = new Set<string>();
  for (const list of [added ?? [], recent ?? []]) {
    for (const e of list) {
      if (!e || (e.kind !== "file" && e.kind !== "folder")) continue;
      const key = attachmentKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      // 注意：这里**刻意不保留 blobKey**——历史会进 localStorage（JSON），
      // 而 blob 数据随会话销毁，留下悬空键只会误导渲染（见 clipboard-image.ts）。
      ordered.push({
        kind: e.kind,
        name: String(e.name ?? ""),
        path: String(e.path ?? ""),
        ...(e.pinned ? { pinned: true } : {}),
      });
    }
  }
  // 固定判定：显式集合优先；否则沿用条目自带的 pinned 标记
  const isPinned = (e: AttachedEntry): boolean => {
    const key = attachmentKey(e);
    if (pinnedSet) return pinnedSet.has(key);
    return !!e.pinned;
  };
  const pinned = ordered.filter(isPinned).map((e) => ({ ...e, pinned: true }));
  const unpinned = ordered.filter((e) => !isPinned(e));
  // 固定不限量；未固定截到 cap
  return [...pinned, ...unpinned.slice(0, Math.max(0, cap))];
}

/**
 * 切换某条历史记录的「固定」状态（按路径/名称键匹配）。
 * 返回新数组（不改原数组）；未命中返回原数组引用。
 * 取消固定后条目**原地保留**（不重新排序）——它的位置由下一次 merge 决定。
 */
export function toggleRecentPin(
  recent: readonly AttachedEntry[],
  key: string
): AttachedEntry[] {
  let changed = false;
  const out = (recent ?? []).map((e) => {
    if (attachmentKey(e) !== key) return e;
    changed = true;
    const next: AttachedEntry = { kind: e.kind, name: e.name, path: e.path };
    if (!e.pinned) next.pinned = true;
    return next;
  });
  return changed ? out : (recent as AttachedEntry[]);
}

/**
 * 构建「附件模式」的结果过滤谓词。
 *
 * @param entries 当前附件（空数组 → 返回 null，表示不过滤 = 常规搜索）
 * @param getRecords 当前插件记录的读取器（惰性取值：注册表变化后无需重建谓词）
 * @returns 谓词：结果项是否保留在列表里。非插件项、禁用插件、未声明
 *          对应 handlers 的插件一律过滤掉；附件里的每个类型至少要有一个
 *          能力覆盖（文件+文件夹混合粘贴时，能处理其一的插件即可入围，
 *          是否真处理由插件自己决定）。
 */
export function buildAttachmentFilter(
  entries: readonly AttachedEntry[],
  getRecords: () => readonly PluginRecord[]
): ((item: SearchItem) => boolean) | null {
  const kinds = attachmentKinds(entries);
  if (kinds.size === 0) return null;
  return (item: SearchItem): boolean => {
    const pid = pluginIdOf(item);
    if (!pid) return false;
    let rec: PluginRecord | undefined;
    try {
      rec = (getRecords() ?? []).find((r) => r?.id === pid);
    } catch (e) {
      return false;
    }
    if (!rec || !rec.enabled) return false;
    const handlers = inputHandlersOf(rec.manifest);
    if (kinds.has("file") && handlers.files) return true;
    if (kinds.has("folder") && handlers.folders) return true;
    return false;
  };
}

/**
 * 附件模式下的占位提示（搜索框在有附件时替换默认占位文案）。
 *
 * 只给最短的操作范式「插件关键词[tab]传入文本」：有附件时结果列表已收敛为
 * 能处理的插件，用户看一眼就知道该敲哪个关键词，不需要再解释过滤规则。
 * `count` 参数保留（调用方按附件数量决定是否切换占位），不再进文案。
 */
export function attachmentPlaceholder(_count: number): string {
  return "插件关键词[tab]传入文本";
}

/** 可用缩略图预览的图片扩展名（与宿主搜索框的预览、Rust 侧白名单保持一致） */
export const PREVIEW_IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
] as const;

/** 取小写扩展名（无扩展名返回空串） */
export function extOf(name: string): string {
  const s = String(name ?? "");
  const dot = s.lastIndexOf(".");
  if (dot <= 0 || dot === s.length - 1) return "";
  return s.slice(dot + 1).toLowerCase();
}

/**
 * 该附件是否可以直接以图片形式展示（搜索框里显示缩略图，不显示文件名）。
 *
 * 两条判据，任一成立即可：
 *   1. 有 `blobKey`——剪贴板位图（截图 / 复制图片），内容已知就是图片，
 *      不受文件名限制（截图兜底名可能是 `image` 这类无扩展名的）；
 *   2. 扩展名在白名单内——普通图片文件，拿不到内容时也能在粘贴瞬间定型 UI。
 */
export function isPreviewImage(
  entry: Pick<AttachedEntry, "kind" | "name" | "blobKey">
): boolean {
  if (!entry || entry.kind !== "file") return false;
  if (String(entry.blobKey ?? "").trim()) return true;
  return (PREVIEW_IMAGE_EXTS as readonly string[]).includes(extOf(entry.name));
}
