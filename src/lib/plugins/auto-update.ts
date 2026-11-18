/**
 * 插件级后台静默自动更新引擎与生命周期调度。
 *
 * 设计契约：
 *   1. **插件级声明 + 用户决定**：清单可选声明 `"autoUpdate": true | false`（未写默认 `false`）；
 *      用户在安装确认弹窗或「设置 → 插件」详情中的开关选择拥有最高优先级。
 *   2. **零空转开销**：当注册表里没有任何 `market` / `builtin` 来源插件开启 `autoUpdate` 时，
 *      定时与呼出检查直接短路返回，**不发起任何网络请求**。
 *   3. **授权即全静默升级**：只要某插件已开启自动更新（`isPluginAutoUpdateEnabled` 为真），
 *      检测到兼容新版本时无论新版本声明了哪些权限，一律在后台静默下载、校验 SHA-256、
 *      授予新清单声明权限并替换落盘（同时保留用户的启用/禁用、自启策略、关闭行为、界面主题等偏好）。
 *   4. **前台交互保护**：用户当前正在前台打开使用的插件本轮暂缓替换，待收起后下一轮再静默更新。
 */

import { isTauri } from "../tauri-bridge.ts";
import { onRegistryChanged, syncRecordGateway, syncShortcutActions } from "./gateway.ts";
import { preparePackage, type InstallFilePayload, type PreparedInstall } from "./install.ts";
import { installPluginPackage, marketFetchRaw } from "./ipc.ts";
import {
  applyUpdateAvailable,
  clearUpdateAvailable,
  diffCatalog,
  MARKET_CATALOG_URL,
} from "./market.ts";
import { compatibleEntries, parseCatalog } from "./market-types.ts";
import { isKnownPermission } from "./permissions.ts";
import {
  createPluginRecord,
  findPlugin,
  isPluginAutoUpdateEnabled,
  loadRegistry,
  saveRegistry,
  upsertPlugin,
  type PluginRecord,
  type PluginRegistryFile,
} from "./registry.ts";
import { markPluginFrontendRestart } from "./restart.ts";

/** 市场目录拉取使用的内置网关身份（Rust `market_fetch_raw` 做白名单与 SHA-256 复核） */
const MARKET_GATEWAY_ID = "com.mysearch.market";

/** 后台定时检查与更新周期：30 分钟 */
export const PLUGIN_AUTO_UPDATE_INTERVAL_MS = 30 * 60 * 1000;

/** 搜索框呼出时的最小节流间隔：5 分钟 */
export const MIN_PLUGIN_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** 当前注册表中是否存在至少一个开启了 `autoUpdate` 的市场/内置插件 */
export function hasAnyAutoUpdatePlugin(reg: PluginRegistryFile): boolean {
  return reg.plugins.some((p) => isPluginAutoUpdateEnabled(p));
}

export interface AutoUpdateRunResult {
  checked: boolean;
  updated: Array<{ id: string; from: string; to: string }>;
  skippedActive: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface AutoUpdateDeps {
  hostVersion?: string;
  fetchRaw?: (pluginId: string, url: string, expectedSha256: string) => Promise<Uint8Array>;
  unpack?: (zipBytes: Uint8Array, hostVersion: string | null) => Promise<PreparedInstall>;
  writePackage?: (pluginId: string, files: InstallFilePayload[]) => Promise<string>;
  readRegistry?: () => PluginRegistryFile;
  writeRegistry?: (reg: PluginRegistryFile) => void;
  syncOneGateway?: (rec: PluginRecord) => Promise<void>;
  syncShortcuts?: (reg: PluginRegistryFile) => Promise<void>;
  markRestart?: (pluginId: string) => void;
  isPluginActiveInForeground?: (pluginId: string) => boolean;
  onPluginUpdated?: (pluginId: string, newVersion: string) => void;
  onBatchUpdated?: (updatedIds: string[]) => void;
}

let inFlight: Promise<AutoUpdateRunResult> | null = null;

function emptyResult(checked: boolean): AutoUpdateRunResult {
  return {
    checked,
    updated: [],
    skippedActive: [],
    failed: [],
  };
}

/**
 * 执行一轮按插件粒度的市场检查与静默自动更新（若无开启自动更新的插件则零网络开销直接返回）。
 */
export function runPluginAutoUpdate(deps: AutoUpdateDeps = {}): Promise<AutoUpdateRunResult> {
  const readReg = deps.readRegistry ?? loadRegistry;
  if (!hasAnyAutoUpdatePlugin(readReg())) {
    return Promise.resolve(emptyResult(false));
  }
  if (inFlight) return inFlight;

  inFlight = executePluginAutoUpdate(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function executePluginAutoUpdate(deps: AutoUpdateDeps): Promise<AutoUpdateRunResult> {
  const readReg = deps.readRegistry ?? loadRegistry;
  if (!hasAnyAutoUpdatePlugin(readReg())) {
    return emptyResult(false);
  }

  const hostVersion =
    deps.hostVersion ?? (typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "");
  const fetchRaw = deps.fetchRaw ?? marketFetchRaw;
  const unpack =
    deps.unpack ??
    ((bytes: Uint8Array, hv: string | null) =>
      preparePackage(bytes, { hostVersion: hv, checkPermissions: isKnownPermission }));
  const writePackage = deps.writePackage ?? installPluginPackage;
  const writeReg = deps.writeRegistry ?? saveRegistry;
  const syncOne = deps.syncOneGateway ?? syncRecordGateway;
  const syncKeys = deps.syncShortcuts ?? syncShortcutActions;
  const markRestart = deps.markRestart ?? markPluginFrontendRestart;

  const catalogBytes = await fetchRaw(MARKET_GATEWAY_ID, MARKET_CATALOG_URL, "");
  const parsed = parseCatalog(new TextDecoder("utf-8").decode(catalogBytes));
  if (!parsed.ok) {
    throw new Error("插件市场目录解析失败");
  }

  const compat = compatibleEntries(parsed.catalog, hostVersion);
  const reg = readReg();
  const diff = diffCatalog(reg, compat);
  applyUpdateAvailable(reg, diff);
  writeReg(reg);

  const out = emptyResult(true);
  // 只更新有效开启了 autoUpdate 的插件；关闭自动更新的插件仅刷新 updateAvailable 角标
  const autoUpdates = diff.updates.filter((u) => isPluginAutoUpdateEnabled(u.rec));
  if (autoUpdates.length === 0) {
    return out;
  }

  for (const { rec, entry } of autoUpdates) {
    if (deps.isPluginActiveInForeground?.(rec.id)) {
      out.skippedActive.push(rec.id);
      continue;
    }

    try {
      const zipBytes = await fetchRaw(MARKET_GATEWAY_ID, entry.downloadUrl, entry.sha256);
      const prepared = await unpack(zipBytes, hostVersion || null);
      if (prepared.manifest.id !== rec.id) {
        throw new Error(`包内清单 ID（${prepared.manifest.id}）与目录条目（${rec.id}）不一致`);
      }

      const freshReg = readReg();
      const current = findPlugin(freshReg, rec.id);
      if (!current || !isPluginAutoUpdateEnabled(current)) {
        continue;
      }

      if (deps.isPluginActiveInForeground?.(rec.id)) {
        out.skippedActive.push(rec.id);
        continue;
      }

      const prevVersion = current.version;
      await writePackage(rec.id, prepared.files);

      const allPerms = [
        ...(prepared.manifest.permissions ?? []),
        ...(prepared.manifest.optionalPermissions ?? []),
      ];
      const commitReg = readReg();
      const incoming = createPluginRecord({
        manifest: prepared.manifest,
        dir: `plugins/${rec.id}`,
        source: { kind: "market", ref: entry.downloadUrl },
        grants: allPerms,
        integrity: { sha256: prepared.sha256, signed: false },
      });
      const merged = upsertPlugin(commitReg, incoming, { preserveUserChoices: true });
      // 新版本声明的必需权限即使曾出现在历史 denied 中也一并放行，确保静默更新后直接可用
      if (merged.denied.length > 0 && prepared.manifest.permissions?.length) {
        const reqSet = new Set(prepared.manifest.permissions);
        merged.denied = merged.denied.filter((d) => !reqSet.has(d));
      }
      clearUpdateAvailable(commitReg, rec.id);
      writeReg(commitReg);

      try {
        markRestart(rec.id);
      } catch (e) {
        console.warn(`[插件自动更新] 写重启标记失败（${rec.id}）:`, e);
      }
      try {
        await syncOne(merged);
      } catch (e) {
        console.warn(`[插件自动更新] 同步网关失败（${rec.id}）:`, e);
      }

      out.updated.push({ id: rec.id, from: prevVersion, to: merged.version });
      deps.onPluginUpdated?.(rec.id, merged.version);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[插件自动更新] 更新 ${rec.id} 失败:`, e);
      out.failed.push({ id: rec.id, error: msg });
    }
  }

  if (out.updated.length > 0) {
    try {
      await syncKeys(readReg());
    } catch (e) {
      console.warn("[插件自动更新] 同步插件快捷键失败:", e);
    }
    deps.onBatchUpdated?.(out.updated.map((u) => u.id));
  }

  return out;
}

/**
 * 搜索主窗口持有的插件自动更新生命周期控制器。
 */
export function createPluginAutoUpdater(
  hooks: {
    isPluginActiveInForeground?: (pluginId: string) => boolean;
    onPluginUpdated?: (pluginId: string, newVersion: string) => void;
    onBatchUpdated?: (updatedIds: string[]) => void;
  } = {}
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let unlistenReg: (() => void) | null = null;
  let lastCheckAt = 0;

  async function trigger(force: boolean): Promise<void> {
    if (!isTauri) return;
    if (!hasAnyAutoUpdatePlugin(loadRegistry())) return;
    if (!force && Date.now() - lastCheckAt < MIN_PLUGIN_RECHECK_INTERVAL_MS) return;
    lastCheckAt = Date.now();
    try {
      await runPluginAutoUpdate({
        isPluginActiveInForeground: hooks.isPluginActiveInForeground,
        onPluginUpdated: hooks.onPluginUpdated,
        onBatchUpdated: hooks.onBatchUpdated,
      });
    } catch (e) {
      console.warn("[插件自动更新] 检查更新失败:", e);
    }
  }

  function schedule(): void {
    if (!isTauri) return;
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    void trigger(true);
    timer = setInterval(() => void trigger(true), PLUGIN_AUTO_UPDATE_INTERVAL_MS);

    if (!unlistenReg) {
      let prevHasAuto = hasAnyAutoUpdatePlugin(loadRegistry());
      unlistenReg = onRegistryChanged(() => {
        const nextHasAuto = hasAnyAutoUpdatePlugin(loadRegistry());
        if (!prevHasAuto && nextHasAuto) {
          void trigger(true);
        }
        prevHasAuto = nextHasAuto;
      });
    }
  }

  function recheckOnSummon(): void {
    void trigger(false);
  }

  function dispose(): void {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    if (unlistenReg) {
      unlistenReg();
      unlistenReg = null;
    }
  }

  return {
    schedule,
    recheckOnSummon,
    dispose,
  };
}
