/**
 * 订阅原文草稿状态（跨面板共享）
 *
 * 原实现把 subscribeDraft 放在 initInteractions 的闭包里，面板销毁重建时靠它保留；
 * 这里改为一个 reactive store，由 App.vue 创建并 provide 给各面板。
 */
import { reactive } from "vue";
import { editSubscribe, getSubscribe, parseSubscribeItems, subscribeItemsToRawText, type SubscribeRow } from "./configShared";

export interface SubscribeDraftState {
  /** 订阅原文（含未保存的编辑），是文本域的唯一数据源 */
  draft: string;
  /** 视图模式：cards=条块管理 | src=源码编辑 */
  view: "cards" | "src";
  /** 「添加订阅」是否展开 */
  addOpen: boolean;
  /** 正在行内编辑的订阅序号（null = 无） */
  editIndex: number | null;
}

export function useSubscribeDraft() {
  const state = reactive<SubscribeDraftState>({
    draft: "",
    view: "cards",
    addOpen: false,
    editIndex: null,
  });

  /** 初始化：从本地读取订阅原文 */
  function init(): void {
    state.draft = getSubscribe();
  }

  /**
   * 将草稿写回订阅原文并持久化，返回有效 tis 数量。
   * @param value 待提交的订阅原文（缺省用当前草稿）
   */
  function commit(value?: string): number {
    if (value != null) state.draft = value;
    return editSubscribe(state.draft);
  }

  /** 从草稿解析出条块列表 */
  function items(): SubscribeRow[] {
    return parseSubscribeItems(state.draft);
  }

  /** 用条块列表重建订阅原文并持久化 */
  function writeItems(rows: Array<Pick<SubscribeRow, "body">>): number {
    return commit(subscribeItemsToRawText(rows));
  }

  /** 追加一段 tis 文本（保留原格式：空行分隔） */
  function append(tisBody: string): void {
    const cur = state.draft.trim();
    state.draft = cur === "" ? tisBody : cur + "\n" + tisBody;
    commit();
  }

  /** 按 tabValue 从订阅原文中移除一条 tis */
  function removeByBody(tisBody: string): void {
    const url = parseSubscribeItems(tisBody)[0]?.url ?? null;
    const lines = state.draft.split("\n").filter((line) => {
      if (!line.includes("<tis::")) return true;
      const m = parseSubscribeItems(line);
      if (m.length > 0 && url != null) return m[0].url !== url;
      return !line.includes(tisBody);
    });
    state.draft = lines.join("\n");
    commit();
  }

  /** 追加（若不存在）或移除（若已存在）一条 tis，返回最终状态 */
  function toggleInstalled(tisBody: string, installed: boolean): void {
    if (installed) removeByBody(tisBody);
    else append(tisBody);
  }

  return { state, init, commit, items, writeItems, append, removeByBody, toggleInstalled };
}

export type SubscribeDraftApi = ReturnType<typeof useSubscribeDraft>;
