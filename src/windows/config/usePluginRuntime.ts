/**
 * 插件运行时控制器 —— 前端侧的「插件管理器」。
 *
 * 职责：
 *   1. 把注册表里的插件**调和**到 Rust 侧（网关同步 / 启停后台进程）；
 *   2. 汇总后台进程状态（面板展示「哪些插件在后台运行中」）；
 *   3. 安装 / 卸载 / 启用 / 禁用 / 权限变更的统一入口（面板只调这里）；
 *   4. 提供「有效自启动」的读写——**用户的决定优先，清单里的只是请求**。
 *
 * 设计原则：注册表（localStorage）是唯一真相源，Rust 侧只持有镜像。
 * 这样即使进程托管层挂了，用户的授权与开关状态也不会丢。
 */

import { reactive, ref } from "vue";
import {
  callPluginBackend,
  clearPluginLog,
  installPluginFromDir,
  installPluginPackage,
  listPluginBackends,
  onPluginDevChanged,
  purgePluginData,
  readPluginLog,
  readPluginText,
  removePluginDir,
  restartPluginBackend,
  startPluginBackend,
  stopPluginBackend,
  watchPluginDir,
  type BackendStatus,
} from "../../lib/plugins/ipc.ts";
import { syncRecordGateway } from "../../lib/plugins/gateway.ts";
import { parsePluginManifest, type PluginManifest } from "../../lib/plugins/manifest.ts";
import { isKnownPermission } from "../../lib/plugins/permissions.ts";
import { isFreshEvent, planReload } from "../../lib/plugins/dev-reload.ts";
import {
  createPluginRecord,
  findPlugin,
  grantPermission,
  loadRegistry,
  markDenied,
  planUpgrade,
  pluginDataClear,
  removePlugin,
  revokeAllPermissions,
  revokePermission,
  saveRegistry,
  upsertPlugin,
  type AutoStartMode,
  type PluginRecord,
  type PluginRegistryFile,
} from "../../lib/plugins/registry.ts";

export function usePluginRuntime() {
  /** 注册表（响应式快照，供面板渲染） */
  const registry = reactive<PluginRegistryFile>(loadRegistry());
  /** 后台进程状态（Rust 上报） */
  const backends = reactive<Record<string, BackendStatus>>({});
  /** 是否正在做耗时操作（安装 / 卸载中，面板禁用按钮） */
  const busy = ref(false);
  /** 最近一次错误（面板提示） */
  const lastError = ref<string | null>(null);

  /** 持久化注册表（内存 → localStorage） */
  function persist(): void {
    saveRegistry({ version: registry.version, plugins: [...registry.plugins] });
  }

  /** 取记录（未装返回 undefined） */
  function get(pluginId: string): PluginRecord | undefined {
    return findPlugin(registry, pluginId);
  }

  /** 需要后台进程的插件列表 */
  function withBackend(): PluginRecord[] {
    return registry.plugins.filter((p) => p.manifest.backend != null && p.source.kind !== "legacy");
  }

  /**
   * 把一个插件调和到 Rust 侧：
   * - 下发网关配置（权限 / 启用态 / 自启策略 / 进程规格）；
   * - 自启策略为 always 时由 Rust 拉起进程（stop 的情况 Rust 会负责停）；
   * - 禁用时同时关闭该插件的所有前台会话并停止进程；
   * - 目录挂载的插件：顺带登记源目录监听（幂等）。
   */
  async function reconcile(pluginId: string): Promise<void> {
    const rec = get(pluginId);
    if (!rec) return;
    try {
      await syncRecordGateway(rec);
    } catch (e) {
      console.warn("[插件] 网关同步失败:", e);
    }
    // 目录挂载：确保监听已登记（幂等；设置窗口与搜索窗口都会调，谁先到都行）
    if (rec.source.dev && rec.source.ref) {
      try {
        await watchPluginDir(rec.id, rec.source.ref, true);
      } catch (e) {
        console.warn(`[插件] 登记目录监听失败（${rec.id}）:`, e);
      }
    }
    await refreshBackends();
  }

  /** 调和全部插件（启动 / 注册表变化时调用） */
  async function reconcileAll(): Promise<void> {
    for (const rec of registry.plugins) {
      if (rec.source.kind === "legacy") continue;
      await reconcile(rec.id);
    }
  }

  /** 刷新后台进程状态 */
  async function refreshBackends(): Promise<void> {
    try {
      const list = await listPluginBackends();
      const seen = new Set<string>();
      for (const s of list) {
        backends[s.pluginId] = s;
        seen.add(s.pluginId);
      }
      // Rust 侧没有的（已停 / 未启动）从快照里清掉
      for (const id of Object.keys(backends)) {
        if (!seen.has(id)) {
          backends[id] = {
            pluginId: id,
            status: "stopped",
            pid: null,
            memoryBytes: null,
            startedAt: null,
            restarts: 0,
            lastError: null,
            keepAliveReasons: [],
          };
        }
      }
    } catch (e) {
      /* 浏览器调试环境无 Rust 侧 */
    }
  }

  /** 同步某插件运行态到注册表（面板与搜索结果共用） */
  function runtimeOf(pluginId: string): BackendStatus {
    const s = backends[pluginId];
    if (s) return s;
    const rec = get(pluginId);
    return {
      pluginId,
      status: rec?.runtime.status === "error" ? "error" : "stopped",
      pid: null,
      memoryBytes: null,
      startedAt: null,
      restarts: 0,
      lastError: rec?.runtime.lastError ?? null,
      keepAliveReasons: [],
    };
  }

  /** 把 Rust 上报的状态写回注册表（持久化展示用，重启后仍能看到上次的异常） */
  function syncRuntimeIntoRegistry(): void {
    for (const rec of registry.plugins) {
      const s = backends[rec.id];
      if (!s) continue;
      rec.runtime = {
        status: s.status,
        pid: s.pid,
        memoryBytes: s.memoryBytes,
        startedAt: s.startedAt,
        restarts: s.restarts,
        lastError: s.lastError,
        keepAliveReasons: s.keepAliveReasons ?? [],
      };
    }
  }

  /** 后台运行中的插件数（面板顶部统计） */
  function runningCount(): number {
    return Object.values(backends).filter((s) => s.status === "running" || s.status === "starting").length;
  }

  /* ============================================================
   * 安装
   * ============================================================ */

  /** 安装（或升级）一个已解析验证过的插件包 */
  async function installFromFiles(input: {
    manifest: PluginManifest;
    dir: string;
    files: Array<{ path: string; data: string; executable?: boolean }>;
    source: PluginRecord["source"];
    sha256: string | null;
    signed?: boolean;
    /** 升级时由调用方处理新增权限确认后再传入 */
    grants: string[];
    /** 保持用户既有选择（升级场景） */
    preserveUserChoices?: boolean;
  }): Promise<PluginRecord> {
    const prev = get(input.manifest.id);
    if (prev) {
      const plan = planUpgrade(prev, input.manifest);
      if (!plan.ok) throw new Error(plan.error ?? "无法升级");
    }
    busy.value = true;
    try {
      await installPluginPackage(input.manifest.id, input.files);
      // 同 id 之前是「目录挂载」的话，这次从文件安装会替换掉它的来源：
      // 旧源目录的监听必须摘掉，否则继续改那个目录会去热重载一个已无关的插件
      if (prev?.source.dev) {
        try {
          await watchPluginDir(prev.id, prev.source.ref ?? prev.dir, false);
        } catch (e) {
          /* 监听不存在时忽略 */
        }
      }
      const record = createPluginRecord({
        manifest: input.manifest,
        dir: input.dir,
        source: input.source,
        grants: input.grants,
        integrity: { sha256: input.sha256, signed: input.signed ?? false },
      });
      const merged = upsertPlugin(registry, record, {
        preserveUserChoices: input.preserveUserChoices !== false,
      });
      persist();
      await reconcile(merged.id);
      return merged;
    } finally {
      busy.value = false;
    }
  }

  /** 开发安装：目录直挂（免打包，改完重启即可看到效果） */
  async function installDevDir(manifestsRaw: string, dir: string): Promise<PluginRecord> {
    const parsed = parsePluginManifest(manifestsRaw, isKnownPermission);
    if (!parsed.ok) throw new Error(`清单校验失败：${parsed.errors.join(", ")}`);
    busy.value = true;
    try {
      await installPluginFromDir(parsed.manifest.id, dir);
      const record = createPluginRecord({
        manifest: parsed.manifest,
        dir,
        source: { kind: "folder", ref: dir, dev: true },
        grants: parsed.manifest.permissions ?? [],
        integrity: { sha256: null, signed: false },
      });
      const merged = upsertPlugin(registry, record);
      persist();
      await reconcile(merged.id);
      // 登记源目录监听：此后改源目录即自动重载（失败只提示，不影响挂载本身）
      try {
        await watchPluginDir(merged.id, dir, true);
      } catch (e) {
        console.warn("[插件] 登记目录监听失败:", e);
        lastError.value = `已挂载，但自动重载监听失败：${String((e as Error)?.message ?? e)}`;
      }
      return merged;
    } finally {
      busy.value = false;
    }
  }

  /** 卸载（deleteData 为 true 时同时清掉插件私有数据） */
  async function uninstall(pluginId: string, deleteData = false): Promise<void> {
    const rec = get(pluginId);
    if (!rec) return;
    busy.value = true;
    try {
      // 先停进程再删文件，避免进程持有文件句柄（Windows 上会删不掉）
      if (rec.manifest.backend) {
        try {
          await stopPluginBackend(pluginId);
        } catch (e) {
          /* 未运行 */
        }
      }
      try {
        await removePluginDir(pluginId);
      } catch (e) {
        // 目录已被用户手工删除时不阻断卸载流程
        console.warn("[插件] 删除插件目录失败:", e);
      }
      // 目录挂载的插件：摘掉源目录监听（目录还在，继续盯着没有意义）
      if (rec.source.dev) {
        try {
          await watchPluginDir(pluginId, rec.source.ref ?? rec.dir, false);
        } catch (e) {
          /* 监听不存在时忽略 */
        }
      }
      if (deleteData) {
        // 两处数据：localStorage（无后端插件用）与 plugin-data/<id>/（后端进程用）
        pluginDataClear(pluginId);
        try {
          await purgePluginData(pluginId);
        } catch (e) {
          console.warn("[插件] 删除插件数据目录失败:", e);
        }
      }
      removePlugin(registry, pluginId);
      persist();
      delete backends[pluginId];
    } finally {
      busy.value = false;
    }
  }

  /* ============================================================
   * 开关与自启动
   * ============================================================ */

  /** 启用 / 禁用插件 */
  async function setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const rec = get(pluginId);
    if (!rec) return;
    rec.enabled = enabled;
    // 禁用时收掉权限？不：Android 语义里禁用不改授权，重新启用不该再弹一遍授权。
    // 但后台进程必须立刻停（reconcile 里 enabled=false → Rust 停止进程）。
    persist();
    await reconcile(pluginId);
  }

  /**
   * 设置后台启动策略（面板上的「开机自启」开关）。
   *
   * 三种取值：
   *   - "always"    ：随应用启动即运行（真正的自启动）
   *   - "on-demand" ：仅在前台打开插件时运行，关闭后按 idleExitSec 停止
   *   - "never"     ：从不自动运行（仍可由前台显式拉起）
   */
  async function setAutoStart(pluginId: string, mode: AutoStartMode): Promise<void> {
    const rec = get(pluginId);
    if (!rec) return;
    rec.autoStart = mode;
    persist();
    await reconcile(pluginId);
  }

  /** 删除插件私有数据（保留插件本体） */
  function clearPluginData(pluginId: string): number {
    return pluginDataClear(pluginId);
  }

  /* ============================================================
   * 权限
   * ============================================================ */

  /** 授予权限 */
  function grant(pluginId: string, permission: string): boolean {
    const rec = get(pluginId);
    if (!rec) return false;
    if (!isKnownPermission(permission)) return false;
    const changed = grantPermission(rec, permission, "settings");
    if (changed) {
      persist();
      void reconcile(pluginId);
    }
    return changed;
  }

  /** 批量授予（安装确认用） */
  function grantAll(pluginId: string, permissions: string[]): void {
    const rec = get(pluginId);
    if (!rec) return;
    for (const p of permissions) {
      if (isKnownPermission(p)) grantPermission(rec, p, "install");
    }
    persist();
    void reconcile(pluginId);
  }

  /** 撤销权限 */
  function revoke(pluginId: string, permission: string): boolean {
    const rec = get(pluginId);
    if (!rec) return false;
    const changed = revokePermission(rec, permission);
    if (changed) {
      persist();
      // 撤销「运行本机程序」等危险权限后立即生效（reconcile 会停掉进程）
      void reconcile(pluginId);
    }
    return changed;
  }

  /** 撤销全部权限（面板上的「重置权限」） */
  function revokeAll(pluginId: string): void {
    const rec = get(pluginId);
    if (!rec) return;
    revokeAllPermissions(rec);
    persist();
    void reconcile(pluginId);
  }

  /** 记录一次用户拒绝（不再反复打扰） */
  function deny(pluginId: string, permission: string): void {
    const rec = get(pluginId);
    if (!rec) return;
    markDenied(rec, permission);
    persist();
  }

  /* ============================================================
   * 后台进程控制（面板按钮）
   * ============================================================ */

  async function startBackend(pluginId: string): Promise<void> {
    try {
      lastError.value = null;
      const s = await startPluginBackend(pluginId);
      backends[pluginId] = s;
    } catch (e) {
      lastError.value = String((e as Error)?.message ?? e);
      throw e;
    } finally {
      await refreshBackends();
    }
  }

  async function stopBackend(pluginId: string): Promise<void> {
    try {
      await stopPluginBackend(pluginId);
    } finally {
      await refreshBackends();
    }
  }

  async function restartBackend(pluginId: string): Promise<void> {
    try {
      lastError.value = null;
      const s = await restartPluginBackend(pluginId);
      backends[pluginId] = s;
    } catch (e) {
      lastError.value = String((e as Error)?.message ?? e);
      throw e;
    } finally {
      await refreshBackends();
    }
  }

  /** 停止全部后台进程（面板「全部停止」/ 应用退出前） */
  async function stopAllBackends(): Promise<void> {
    for (const rec of registry.plugins) {
      if (rec.manifest.backend && backends[rec.id]?.status !== "stopped") {
        try {
          await stopPluginBackend(rec.id);
        } catch (e) {
          /* ignore */
        }
      }
    }
    await refreshBackends();
  }

  /* ============================================================
   * 调试辅助
   * ============================================================ */

  /** 读取插件日志尾部 */
  async function logOf(pluginId: string, maxLines = 200): Promise<string> {
    try {
      return await readPluginLog(pluginId, maxLines);
    } catch (e) {
      return `读取日志失败: ${String((e as Error)?.message ?? e)}`;
    }
  }

  /** 清空插件日志 */
  async function clearLog(pluginId: string): Promise<void> {
    try {
      await clearPluginLog(pluginId);
    } catch (e) {
      /* ignore */
    }
  }

  /** 读取插件内文本文件（面板预览插件清单 / 调试） */
  async function readText(pluginId: string, relPath: string): Promise<string> {
    return await readPluginText(pluginId, relPath);
  }

  /** 调用插件后端方法（供插件设置面板 / 手动测试用） */
  async function callBackend(pluginId: string, method: string, params: unknown = null): Promise<unknown> {
    return await callPluginBackend(pluginId, method, params);
  }

  /* ============================================================
   * 开发插件（目录挂载）的自动重载 —— 设置窗口侧
   * ============================================================ */

  /** 事件监听取消函数（窗口卸载时调用） */
  let unlistenDevChanged: (() => void) | null = null;

  /**
   * 监听「开发插件变化」事件，把新清单合并进面板正在展示的注册表。
   *
   * 与搜索窗口的分工：**这里只更新展示**（名称 / 版本 / 描述 / 搜索项 / 权限
   * 的待确认状态），不做视图重挂与进程重启——那两个动作属于前台会话。
   * 面板上的记录是 `reactive` 的，就地改字段即可刷新界面。
   *
   * 串行消费：同一插件的连续事件按序处理，避免并发读清单互相覆盖。
   */
  async function startDevWatcher(): Promise<void> {
    if (unlistenDevChanged) return;
    let chain: Promise<void> = Promise.resolve();
    const unlisten = await onPluginDevChanged((payload) => {
      if (!payload?.pluginId) return;
      if (!isFreshEvent(payload)) return;
      chain = chain
        .then(() => applyDevChange(payload.pluginId))
        .catch((e) => {
          console.warn(`[插件] 处理开发目录变化失败（${payload.pluginId}）:`, e);
        });
    });
    unlistenDevChanged = unlisten;
  }

  /** 停止监听（窗口卸载） */
  function stopDevWatcher(): void {
    unlistenDevChanged?.();
    unlistenDevChanged = null;
  }

  /**
   * 把一次源目录变化应用到面板上的记录。
   *
   * 与搜索窗口共用 `planReload` 纯函数：合并规则（用户态保留、新权限不静默
   * 授予）只有一份实现，两个窗口不会跑出不同的结果。
   */
  async function applyDevChange(pluginId: string): Promise<void> {
    const rec = get(pluginId);
    if (!rec || !rec.source.dev) return;
    let manifestText: string;
    try {
      manifestText = await readPluginText(pluginId, "plugin.json");
    } catch (e) {
      console.warn(`[插件] 重新读取清单失败（${pluginId}）:`, e);
      return;
    }
    const plan = planReload(rec, manifestText);
    if (!plan.proceed) {
      console.warn(`[插件] 跳过本次热重载（${pluginId}）: ${plan.reason}`);
      return;
    }
    // 就地合并进 reactive 记录（保留引用，面板无需重渲染整棵列表）
    Object.assign(rec, plan.record);
    persist();
    try {
      await syncRecordGateway(rec);
    } catch (e) {
      console.warn(`[插件] 热重载后网关同步失败（${pluginId}）:`, e);
    }
    if (plan.versionChanged) {
      console.info(`[插件] 「${rec.name}」已热重载：v${plan.fromVersion} → v${plan.record.version}`);
    }
  }

  return {
    registry,
    backends,
    busy,
    lastError,
    /** 持久化注册表到 localStorage */
    persist: () => persist(),
    // 查询
    get,
    withBackend,
    runtimeOf,
    runningCount,
    syncRuntimeIntoRegistry,
    // 调和
    reconcile,
    reconcileAll,
    refreshBackends,
    // 安装
    installFromFiles,
    installDevDir,
    uninstall,
    // 开关
    setEnabled,
    setAutoStart,
    clearPluginData,
    // 权限
    grant,
    grantAll,
    revoke,
    revokeAll,
    deny,
    // 进程
    startBackend,
    stopBackend,
    restartBackend,
    stopAllBackends,
    // 调试
    logOf,
    clearLog,
    readText,
    callBackend,
    // 开发插件（目录挂载）的自动重载
    startDevWatcher,
    stopDevWatcher,
  };
}

export type PluginRuntimeApi = ReturnType<typeof usePluginRuntime>;

/** 全局单例（两个窗口共享同一份状态） */
let shared: PluginRuntimeApi | null = null;

/** 取插件运行时（首次调用时创建） */
export function useSharedPluginRuntime(): PluginRuntimeApi {
  if (!shared) shared = usePluginRuntime();
  return shared;
}
