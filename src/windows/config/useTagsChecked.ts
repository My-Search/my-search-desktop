/**
 * 关注标签勾选态（跨面板共享，面板不保活时也能保存）
 */
import { reactive } from "vue";
import { storageGet, storageSet } from "../../lib/util";
import { DEFAULT_UNFOLLOW, TAGS_KEY, UNFOLLOW_KEY } from "./configShared";
import type { TagStat } from "../../types/index";

export function useTagsChecked() {
  /** 标签名 -> 是否勾选 */
  const checked = reactive(new Map<string, boolean>());
  /** 有未保存勾选时，外部数据进来要「合并」而不是覆盖 */
  let dirty = false;
  /** 标签统计签名（名称+数量），用于判断外部数据是否变化而需要重渲染 */
  let signature = "";

  /** 标签统计签名（名称 + 数量），任一变化都需重渲染面板 */
  function computeSignature(): string {
    const tagsOfData = storageGet<TagStat[] | null>(TAGS_KEY, null);
    if (!Array.isArray(tagsOfData)) return "";
    return tagsOfData.map((t) => `${t.name}:${t.count ?? 0}`).join("|");
  }

  /** 当前签名（外部缓存变了就与它不一致） */
  function currentSignature(): string {
    return signature;
  }

  function setSignature(v: string): void {
    signature = v;
  }

  /**
   * 从缓存载入勾选态。
   * 有未保存改动时采用「合并」而不是覆盖：保留用户已经点过的勾选，
   * 只把新出现的标签按存储里的默认值补进来（否则切到主窗口再回来会丢改动）。
   */
  function load(): void {
    const userUnfollowList = storageGet<string[] | null>(UNFOLLOW_KEY, null) ?? DEFAULT_UNFOLLOW;
    const unfollow = new Set(userUnfollowList);
    const tagsOfData = storageGet<TagStat[] | null>(TAGS_KEY, null);
    if (!Array.isArray(tagsOfData)) {
      checked.clear();
      return;
    }

    const previous = new Map(checked);
    const next = new Map<string, boolean>();
    for (const item of tagsOfData) {
      const storedChecked = !unfollow.has(item.name);
      // 未编辑过：完全以存储为准；已编辑：保留用户勾选，只补新标签
      next.set(item.name, !dirty || !previous.has(item.name) ? storedChecked : previous.get(item.name)!);
    }
    checked.clear();
    for (const [k, v] of next) checked.set(k, v);
  }

  /** 保存关注标签：把勾选态写回缓存 */
  function save(): void {
    const followed: string[] = [];
    const unfollowed: string[] = [];
    for (const [name, isChecked] of checked) {
      (isChecked ? followed : unfollowed).push(name);
    }
    // 剃除已转关注的，添加新关注的
    let userUnfollowList = (storageGet<string[] | null>(UNFOLLOW_KEY, null) ?? DEFAULT_UNFOLLOW).filter(
      (item) => !followed.includes(item)
    );
    userUnfollowList = userUnfollowList.concat(
      unfollowed.filter((item) => !userUnfollowList.includes(item))
    );
    storageSet(UNFOLLOW_KEY, userUnfollowList);
    dirty = false;
  }

  /** 用户改动某个标签的勾选 */
  function setChecked(name: string, value: boolean): void {
    checked.set(name, value);
    dirty = true;
  }

  /** 是否有未保存的勾选改动（App 判断是否需要重渲染用） */
  function isDirty(): boolean {
    return dirty;
  }

  return {
    checked,
    computeSignature,
    currentSignature,
    setSignature,
    load,
    save,
    setChecked,
    isDirty,
  };
}

export type TagsCheckedApi = ReturnType<typeof useTagsChecked>;
