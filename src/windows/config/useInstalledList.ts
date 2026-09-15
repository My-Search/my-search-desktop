/**
 * 已安装订阅列表（TisHub 安装/移除的本地记录）
 *
 * 原实现把 installedList 放在 initInteractions 的闭包里；这里抽成 reactive store，
 * 订阅管理面板与订阅市场面板共享。
 */
import { ref } from "vue";
import { storageGet, storageSet } from "../../lib/util";
import { rebuildTags } from "../../lib/subscribe-parser";
import { TISHUB_KEY } from "./configShared";
import type { InstalledSubscribe } from "../../types/index";
import type { SubscribeDraftApi } from "./useSubscribeDraft";

/** 已安装订阅（兼容旧字段命名） */
export interface InstalledTis {
  name: string;
  describe: string;
  body: string;
  state: string;
}

export function useInstalledList(draft: SubscribeDraftApi) {
  const items = ref<InstalledTis[]>([]);

  /** 重新从订阅原文 + 本地记录推导已安装列表 */
  function reload(): void {
    const fromText: InstalledTis[] = draft
      .items()
      .map((tis) => ({
        name: tis.name,
        describe: tis.describe || "",
        body: rebuildTags([{ tabName: "tis", tabValue: tis.url, title: tis.name, describe: tis.describe }]),
        state: "enable",
      }));
    const stored = ((storageGet<InstalledSubscribe[] | null>(TISHUB_KEY, []) ?? []) as InstalledTis[]).filter(
      (it) => it.state === "disable"
    );
    const names = new Set(fromText.map((it) => it.name));
    items.value = [...fromText, ...stored.filter((it) => !names.has(it.name))];
  }

  function persist(): void {
    storageSet(TISHUB_KEY, items.value);
  }

  function list(): InstalledTis[] {
    return items.value;
  }

  function findByName(name: string): InstalledTis | undefined {
    return items.value.find((item) => item.name === name);
  }

  /** 安装一条订阅（写入订阅原文 + 记录已安装） */
  function install(tis: InstalledTis): void {
    draft.append(tis.body);
    items.value.unshift(tis);
    persist();
  }

  /** 移除一条订阅（从订阅原文删除 + 从记录移除） */
  function remove(tis: InstalledTis): void {
    draft.removeByBody(tis.body);
    items.value = items.value.filter((item) => item.name !== tis.name);
    persist();
  }

  return { items, reload, persist, list, findByName, install, remove };
}

export type InstalledListApi = ReturnType<typeof useInstalledList>;
