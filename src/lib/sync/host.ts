/**
 * SyncHost —— 应用内**唯一的同步执行者**（常驻主窗口）。
 *
 * 为什么只有一份
 * --------------
 * 旧实现让设置窗口和搜索窗口各建一份引擎，两边各持一份内存状态：
 *   - 设置窗口一关，`lastSyncAt` 归零，主窗口首次自动同步判成「本机更新」；
 *   - 两个窗口同时点同步会并发 PUT 同一个远端文件；
 *   - 插件 `ms.sync.trigger()` 与面板互相看不见对方的结果。
 *
 * 现在：
 *   - 主窗口（常驻）持有 SyncHost，负责所有同步轮次；
 *   - 设置窗口只发 `sync_request` / `sync_resolve_choice`，订阅 `sync://status`；
 *   - Rust 侧另有全局传输门与持久化状态，进程内/跨窗口都不会并发或丢基线。
 *
 * 触发来源：启动首个轮次、数据变化（5 秒节流）、Rust 心跳（60 秒，按用户
 * 间隔判定）、设置窗口/插件的手动请求。
 */

import { syncDataDigest, syncGetConfig, syncRequest, syncResolveChoice, syncStateGet, syncStatePatch, type SyncConfig, type SyncPersistedState } from "./bridge";
import { intervalMsOf, ON_CHANGE_THROTTLE_MS, type SyncRunState } from "./engine";
import { runCloudRound } from "./cloud";
import { shouldSyncKey } from "./snapshot";
import { setOnStorageChange } from "../util";
import { isTauri, onSyncConfigChanged, type UnlistenFn } from "../tauri-bridge";
import { debug, warn } from "../logger";
import type { PluginSyncState } from "../plugins/host.ts";

type StateListener = (state: SyncRunState) => void;

function emptyState(persisted?: SyncPersistedState): SyncRunState {
  return {
    status: "idle",
    lastSyncAt: persisted?.lastSyncAt ?? 0,
    lastError: "",
    remoteMeta: null,
    localDigest: persisted?.lastLocalDigest ?? "",
    initialized: persisted?.initialized ?? false,
    remoteRev: persisted?.remoteRev ?? "",
    needsChoice: false,
    choiceReason: "",
    conflicts: persisted?.conflicts ?? [],
    epoch: persisted?.epoch ?? 1,
  };
}

class SyncHost {
  private started = false;
  private starting: Promise<void> | null = null;
  private config: SyncConfig | null = null;
  private state: SyncRunState = emptyState();
  private listeners = new Set<StateListener>();
  private unlisteners: UnlistenFn[] = [];
  private queue: Promise<SyncRunState> = Promise.resolve(this.state);
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickCheck = 0;
  /** 上次比对到的「落盘可同步数据」指纹（心跳探测外部写入用；空串 = 尚无基线） */
  private lastDataDigest = "";
  /** 已排队/执行中的轮次数（心跳据此避免在慢网络下堆叠轮次） */
  private pendingRounds = 0;
  /** 插件级裁决（只在对应插件仍是冲突时保留；core 用 `""`） */
  private choices: Record<string, "local" | "remote"> = {};
  private emitEvent: ((name: string, payload?: unknown) => Promise<void>) | null = null;
  private storageListener: ((e: StorageEvent) => void) | null = null;

  /** 启动宿主（幂等）。只在主窗口调用。 */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) return await this.starting;
    this.starting = (async () => {
      try {
        this.config = await syncGetConfig();
      } catch (e) {
        warn("[同步] 读取配置失败，同步宿主暂不可用:", e);
      }
      try {
        this.state = emptyState(await syncStateGet());
      } catch (e) {
        warn("[同步] 读取持久化状态失败:", e);
      }
      this.started = true;

      // 存储变化 → 5 秒节流后自动同步
      setOnStorageChange((key) => {
        if (!shouldSyncKey(key)) return;
        this.scheduleOnChange();
      });

      // 其它窗口（设置窗口 / 独立插件窗口）写同一份 localStorage 时，
      // 本窗口的 storageSet 钩子不会触发，只会有浏览器 `storage` 事件。
      // 没有这条监听，插件在独立窗口写的数据要等下一次兜底轮询才会同步。
      if (typeof window !== "undefined") {
        this.storageListener = (e: StorageEvent) => {
          const full = e.key ?? "";
          if (!full.startsWith("my-search-desktop:")) return;
          if (!shouldSyncKey(full.slice("my-search-desktop:".length))) return;
          this.scheduleOnChange();
        };
        window.addEventListener("storage", this.storageListener);
      }

      if (isTauri) {
        void this.bindTauriEvents();
      }

      this.publish(this.state);
      if (this.config?.enabled) void this.request("initial");
      debug(`[同步] SyncHost 已启动（enabled=${!!this.config?.enabled}）`);
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** 停止宿主（应用退出时调用；不删除持久化状态） */
  dispose(): void {
    for (const un of this.unlisteners) un();
    this.unlisteners = [];
    setOnStorageChange(null);
    if (this.storageListener && typeof window !== "undefined") {
      window.removeEventListener("storage", this.storageListener);
      this.storageListener = null;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.started = false;
    this.config = null;
  }

  /** 当前状态（副本） */
  status(): SyncRunState {
    return { ...this.state };
  }

  /** 当前配置（可能为空，调用方自行兜底） */
  currentConfig(): SyncConfig | null {
    return this.config;
  }

  /** 订阅状态变化；返回取消函数 */
  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn);
    fn({ ...this.state });
    return () => this.listeners.delete(fn);
  }

  /** 面板/插件触发一轮同步，返回本轮结束后的状态 */
  async request(trigger = "manual", choice?: "local" | "remote"): Promise<SyncRunState> {
    await this.start();
    const run = async (): Promise<SyncRunState> => this.runRound(trigger, choice);
    this.pendingRounds++;
    const next = this.queue.then(run, run).finally(() => {
      this.pendingRounds = Math.max(0, this.pendingRounds - 1);
    });
    this.queue = next.catch(() => this.state);
    return await next;
  }

  /**
   * 用户做出选择，并立即继续同步。
   *
   * - `pluginIds` 省略 = 全局选择（首次连接、或「全部按这个来」）；
   * - `pluginIds` 给定 = 只对这几个插件生效（`""` 是 core / 软件主体配置），
   *   其它插件的冲突保持挂起，互不影响。
   *
   * `broadcast=true` 时把选择广播给其它窗口（设置窗口点按钮走 Rust 命令 →
   * `sync://choice`，主窗口只执行本地轮次，不会再广播一次，否则会自激）。
   */
  async resolveChoice(
    choice: "local" | "remote",
    pluginIds?: string[],
    broadcast = true
  ): Promise<SyncRunState> {
    await this.start();
    if (pluginIds) {
      for (const id of pluginIds) this.choices[id] = choice;
    } else {
      // 全局裁决：清掉旧的逐插件决定，否则它们优先级更高会盖掉本次选择
      this.choices = {};
    }
    if (broadcast && isTauri) {
      try {
        await syncResolveChoice(choice, pluginIds);
      } catch {
        /* 本窗口没有 Tauri 事件总线时直接走下面的 request */
      }
    }
    // 插件级裁决绝不下传全局 `choice`，否则等于「这一片冲突 → 全部插件都按这边覆盖」
    const trigger = choice === "remote" ? "choice-remote" : "choice-local";
    return await this.request(trigger, pluginIds ? undefined : choice);
  }

  /** 重新读配置（设置窗口保存后广播触发） */
  async reloadConfig(): Promise<void> {
    try {
      this.config = await syncGetConfig();
    } catch (e) {
      return;
    }
    if (!this.config.enabled) {
      this.publish({ ...this.state, status: "idle", needsChoice: false });
      return;
    }
    void this.request("config-changed");
  }

  /* ===================== 内部 ===================== */

  private async runRound(trigger: string, choice?: "local" | "remote"): Promise<SyncRunState> {
    if (!this.config) {
      try {
        this.config = await syncGetConfig();
      } catch (e) {
        this.state = {
          ...this.state,
          status: "error",
          lastError: (e as Error)?.message ?? "读取同步配置失败",
        };
        this.publish(this.state);
        return this.state;
      }
    }
    const next = await runCloudRound(
      {
        getConfig: () => this.config as SyncConfig,
        getState: () => syncStateGet(),
        // v2 的分片基线字段（cloudFormat / manifestEtag / shards / pending / conflicts）也在白名单内
        patchState: (p) => syncStatePatch(p as Parameters<typeof syncStatePatch>[0]),
        // 设置存在 Rust 的 settings.json，由内核分片的摘要覆盖（不再单独读）
        onState: (st) => this.publish(st),
        choice,
        choices: { ...this.choices },
        coreChoice: this.choices[""],
      },
      trigger,
      this.state
    );
    // 只保留仍然是冲突的裁决，避免「上次冲突的选择」以后误伤已恢复的插件
    const alive = new Set(next.conflicts.map((c) => c.pluginId));
    for (const id of Object.keys(this.choices)) {
      if (!alive.has(id)) delete this.choices[id];
    }
    this.state = next;
    this.publish(next);
    return next;
  }

  private publish(state: SyncRunState): void {
    this.state = { ...state };
    for (const fn of this.listeners) {
      try {
        fn({ ...state });
      } catch {
        /* 订阅方异常不影响同步 */
      }
    }
    if (!isTauri) return;
    void (async () => {
      try {
        if (!this.emitEvent) {
          const mod = await import("@tauri-apps/api/event");
          this.emitEvent = (name, payload) => mod.emit(name, payload);
        }
        await this.emitEvent("sync://status", { ...state });
      } catch {
        /* 事件总线不可用（浏览器调试） */
      }
    })();
  }

  private scheduleOnChange(): void {
    if (!this.config?.enabled || !this.config.autoOnChange) return;
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      void this.request("onChange");
    }, ON_CHANGE_THROTTLE_MS);
  }

  private async bindTauriEvents(): Promise<void> {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unRequest = await listen<{ trigger?: string }>("sync://request", (e) => {
        const trigger = e.payload?.trigger;
        if (trigger === "status") {
          // 面板刚打开时的只读快照：不跑网络，只把当前状态（可能还在
          // needs-choice）回播一次，避免用户误以为「上次同步」就是最新。
          this.publish(this.state);
          return;
        }
        if (trigger === "choice-local") {
          void this.resolveChoice("local");
        } else if (trigger === "choice-remote") {
          void this.resolveChoice("remote");
        } else {
          void this.request(trigger || "manual");
        }
      });
      this.unlisteners.push(unRequest);

      const unChoice = await listen<{ choice?: string; pluginIds?: string[] | null }>("sync://choice", (e) => {
        const choice = e.payload?.choice === "remote" ? "remote" : "local";
        const ids = Array.isArray(e.payload?.pluginIds) ? e.payload!.pluginIds! : undefined;
        void this.resolveChoice(choice, ids, false);
      });
      this.unlisteners.push(unChoice);

      const unTick = await listen("sync://tick", () => this.onTick());
      this.unlisteners.push(unTick);

      // 插件的**文件存储**（Rust 侧 `plugin-data/`）被后端或脚本写入时也属于
      // 「用户数据变化」。没有这条监听，写文件存储不会触发自动同步，
      // 云端的插件数据会长期滞后（用户看到的正是「插件数据不同步」）。
      const unPluginData = await listen("plugin-data://changed", () => this.scheduleOnChange());
      this.unlisteners.push(unPluginData);

      // 插件的**云数据 store**（`sync-store/<id>.json`，`ms.store.sync.*`）：
      // 这份数据的唯一用途就是跨设备同步，写完必须立刻安排一轮上传。
      const unPluginSync = await listen("plugin-sync://changed", () => this.scheduleOnChange());
      this.unlisteners.push(unPluginSync);

      // Rust 侧写入的其它「可同步数据」变化（settings.json 落盘、剪贴板历史索引等）：
      // 这些写入不经过前端 `storageSet`，没有这条监听就要等 30 分钟兜底轮询才上传。
      const unDataChanged = await listen("sync://data-changed", () => this.scheduleOnChange());
      this.unlisteners.push(unDataChanged);

      // 浏览器调试环境没有 Tauri 事件总线；插件文件 KV 写入口会派发同窗事件。
      const onDevPluginData = (): void => this.scheduleOnChange();
      window.addEventListener("plugin-data://changed-dev", onDevPluginData);
      window.addEventListener("plugin-sync://changed-dev", onDevPluginData);
      this.unlisteners.push(() => {
        window.removeEventListener("plugin-data://changed-dev", onDevPluginData);
        window.removeEventListener("plugin-sync://changed-dev", onDevPluginData);
      });
    } catch (e) {
      warn("[同步] 绑定 Tauri 事件失败:", e);
    }

    const unConfig = await onSyncConfigChanged(() => {
      void this.reloadConfig();
    });
    if (unConfig) this.unlisteners.push(unConfig);
  }

  /** Rust 每分钟心跳：按用户的兜底间隔决定是否执行 */
  private onTick(): void {
    if (!this.config?.enabled) return;
    // 慢网络下上一轮还没结束（或已排队）时不再叠加：心跳只是兜底，
    // 不是「每分钟强制跑一次」。
    if (this.pendingRounds > 0) return;

    // 【本地数据变化探测】插件后端（录屏、AI 会话等）可能直接写
    // `plugin-data/`，不经过任何宿主 API、也不会发事件。这里用心跳顺带比对
    // 一次「落盘数据指纹」：变了就按数据变化的语义安排一轮同步（5 秒节流），
    // 而不是干等兜底间隔（默认 30 分钟）。
    void this.detectExternalDataChange();

    const now = Date.now();
    // 心跳本身不写状态；用上次成功同步时间判断，避免睡眠唤醒后连续补跑
    const interval = intervalMsOf(this.config);
    if (now - this.state.lastSyncAt < interval) return;
    // 60 秒内最多因心跳触发一次（防止事件重复到达）
    if (now - this.lastTickCheck < 55_000) return;
    this.lastTickCheck = now;
    void this.request("background");
  }

  /**
   * 比对「本机可同步落盘数据」的指纹，发现外部（非宿主 API）写入就安排同步。
   *
   * 只做一次 metadata 遍历（不读文件内容），目录里有大文件也不会拖慢心跳。
   * 首次取到的指纹作为基线，不触发（避免启动时凭空空跑一轮）。
   */
  private async detectExternalDataChange(): Promise<void> {
    let digest: string;
    try {
      digest = await syncDataDigest();
    } catch {
      return; // 浏览器调试 / IPC 抖动：交给兜底轮询
    }
    if (!digest) return;
    if (this.lastDataDigest === "") {
      this.lastDataDigest = digest;
      return;
    }
    if (digest === this.lastDataDigest) return;
    this.lastDataDigest = digest;
    this.scheduleOnChange();
  }
}

/** 全局单例：主窗口常驻，其他窗口通过 Tauri 命令间接使用 */
export const syncHost = new SyncHost();

/** 插件 `ms.sync.status()` 的视图 */
export function pluginSyncState(host: SyncHost = syncHost): PluginSyncState {
  const st = host.status();
  return {
    enabled: !!host.currentConfig()?.enabled,
    status:
      st.status === "needs-choice"
        ? "idle"
        : st.status === "syncing"
          ? "syncing"
          : st.status,
    lastSyncAt: st.lastSyncAt,
    lastError: st.lastError,
  };
}
