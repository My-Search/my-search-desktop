/**
 * 搜索窗口的同步桥 —— 让插件（`ms.sync.*`）能用上数据同步。
 *
 * 为什么搜索窗口也要有同步引擎
 * ---------------------------
 * 同步引擎原本只活在设置窗口的「备份与同步」面板里（面板挂载才创建、关闭即销毁），
 * 而插件界面都跑在**搜索窗口**。插件调 `ms.sync.trigger()` 时设置窗口大概率没开着，
 * 因此这里在搜索窗口也建一份引擎。
 *
 * 只在「真用得上」时才建
 * --------------------
 * 引擎一旦 `startBackground()` 就会起一个兜底定时器并立即跑一轮同步。对绝大多数
 * 用户（没装任何申请 `sync` 权限的插件）这属于纯粹的多余开销与意外的网络行为，
 * 所以：
 *   - 没有「已启用且已授予 sync」的插件时**完全不创建**；
 *   - 有的话也**不注册存储变更钩子**（那会把每次编辑都变成一次上传），
 *     只提供「手动触发 + 定时兜底」——定时兜底沿用用户的 `intervalMinutes`。
 *
 * 与设置窗口的关系：两个窗口各持一份配置副本，触发前**重新读一次配置**，
 * 避免用户刚在设置窗口改了地址/密码，插件这边还拿旧的去打。
 */

import { createSyncEngine, type SyncEngine, type SyncRunState } from "../../lib/sync/engine.ts";
import { syncGetConfig, type SyncConfig } from "../../lib/sync/bridge.ts";
import { onSyncConfigChanged, type UnlistenFn } from "../../lib/tauri-bridge.ts";
import { storageGet } from "../../lib/util.ts";
import { debug } from "../../lib/logger.ts";
import type { PluginSyncState } from "../../lib/plugins/host.ts";

/** 桥的对外 API（就两口：读状态、触发一轮） */
export interface SyncBridge {
  status: () => PluginSyncState;
  now: () => Promise<PluginSyncState>;
  /** 判定是否需要引擎（插件清单变了时重新评估） */
  ensure: (needed: boolean) => Promise<void>;
  dispose: () => void;
}

export function useSyncBridge(): SyncBridge {
  let engine: SyncEngine | null = null;
  let config: SyncConfig | null = null;
  let booting: Promise<void> | null = null;
  let last: SyncRunState | null = null;
  let unlisten: UnlistenFn | null = null;
  /** 是否仍有插件申请 sync 权限（ensure 的判定结果，重建引擎时要用） */
  let needed = false;

  // 设置窗口改了同步配置（关开关、改地址密码）→ 立即重读并按需启停引擎。
  // 若不监听，关掉开关后这边的兜底定时器会拿着旧配置继续轮询。
  void onSyncConfigChanged(() => { void refreshConfig(); })
    .then((fn) => { unlisten = fn; });

  function snapshot(): PluginSyncState {
    return {
      enabled: !!config?.enabled,
      status: last?.status ?? "idle",
      lastSyncAt: last?.lastSyncAt ?? 0,
      lastError: last?.lastError ?? "",
    };
  }

  /** 新建引擎（配置读不到就当作未启用：不建引擎，也不报错） */
  function boot(cfg: SyncConfig): void {
    config = cfg;
    engine = createSyncEngine(
      cfg,
      () => storageGet("shortcut_bindings", []),
      () => true,
      (st) => {
        last = st;
      },
      async (meta) => {
        // 冲突询问：搜索窗口没有地方画确认框，不能替用户拍板丢掉远端那份。
        // `cloud.rs sync_upload` 是无条件 PUT（没有 If-Match/rev 保护），只要远端在
        // 上次同步之后被改过，本机覆盖就**不可逆**。此时直接抛错，内核会把它转成
        // `{ status: "error", lastError }` 回给插件/调用方，让用户去设置窗口
        // （那里有确认框）决定覆盖方向。
        if (meta.remoteModified > meta.lastSyncAt) {
          throw new Error(
            "数据同步冲突：远端在上次同步后有新改动，当前窗口无法确认覆盖方向，请到「设置 → 备份与同步」处理"
          );
        }
        // 远端自上次同步以来没变过 → 本机覆盖是安全的（与改造前行为一致）
        return "local";
      }
    );
    if (cfg.enabled) engine.startBackground();
    debug(`[同步] 搜索窗口已挂载同步引擎（enabled=${cfg.enabled}）`);
  }

  async function ensure(neededFlag: boolean): Promise<void> {
    needed = neededFlag;
    if (!neededFlag) {
      if (engine) {
        engine.stop();
        engine = null;
        config = null;
        debug("[同步] 已无插件申请同步权限，停止搜索窗口同步引擎");
      }
      return;
    }
    if (engine || booting) {
      // 已经建好：只把配置刷新一次（用户在设置窗口改过地址/密码的情形）
      if (engine) void refreshConfig();
      return;
    }
    booting = (async () => {
      try {
        boot(await syncGetConfig());
      } catch (e) {
        console.warn("[同步] 读取同步配置失败，插件同步不可用:", e);
      } finally {
        booting = null;
      }
    })();
    await booting;
  }

  /** 触发前/收到配置变更广播时重读配置：跨窗口改配置后不必重启应用。
   *  关键：用户在设置窗口关掉同步后，要把本窗口的兜底定时器停掉——
   *  只改 config 不停引擎，定时器会拿着旧配置继续轮询；
   *  反过来重新开启时（引擎已被拆）也要重建，且只在仍有插件申请权限时。 */
  async function refreshConfig(): Promise<void> {
    try {
      const cfg = await syncGetConfig();
      config = cfg;
      if (!cfg.enabled) {
        // 先 reconfigure 再拆：reconfigure 会把引擎闭包里的配置对象也改成
        // enabled=false，已在排程/在途的轮次会被内核守卫拦住；直接拆的话
        // 在途轮次还握着旧配置，可能再发最后一次上传。
        engine?.reconfigure(cfg);
        engine?.stop();
        engine = null;
        debug("[同步] 配置已关闭，停止搜索窗口同步引擎");
        return;
      }
      if (!engine) {
        if (!needed) return;
        boot(cfg);
        return;
      }
      engine.reconfigure(cfg);
    } catch (e) {
      /* 读不到就沿用旧配置（触发时仍会再失败一次，错误会回给插件） */
    }
  }

  async function now(): Promise<PluginSyncState> {
    if (!engine) {
      throw new Error("尚未启用数据同步（请先在「设置 → 备份与同步」里开启并配置云端同步）");
    }
    await refreshConfig();
    if (!config?.enabled) {
      throw new Error("数据同步已关闭（请先在「设置 → 备份与同步」里开启）");
    }
    await engine.syncNow();
    return snapshot();
  }

  return {
    status: snapshot,
    now,
    ensure,
    dispose: () => {
      unlisten?.();
      unlisten = null;
      engine?.stop();
      engine = null;
      config = null;
    },
  };
}
