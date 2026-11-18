/**
 * 插件市场能力模块（`ms.market.*`，gate: `plugin.install`）。
 */

import { groupPermissions, isKnownPermission } from "../permissions.ts";
import { iconDataUrl, isInlineIconRef } from "../icon.ts";
import type { PluginManifest } from "../manifest.ts";
import {
  createPluginRecord,
  findPlugin,
  loadRegistry,
  resolveInstallDialogAutoUpdate,
  saveRegistry,
  upsertPlugin,
} from "../registry.ts";
import type { CallRunner, PluginHostContext } from "./core.ts";
import { disposePluginHostSession } from "./event-hub.ts";

/** 插件市场目录地址 */
export const MARKET_CATALOG_URL =
  "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.dist.json";

/** 市场插件自身的网关 key（其网关已声明 `plugin.install` 授权） */
const MARKET_PLUGIN_ID = "com.mysearch.market";

function iconUrlOf(prepared: {
  manifest: PluginManifest;
  files: readonly { path: string; data: string }[];
}): string | null {
  const ref = prepared.manifest.icon;
  if (!ref) return null;
  if (isInlineIconRef(ref)) return ref;
  const file = prepared.files.find((f) => f.path === ref);
  return file ? iconDataUrl(ref, file.data) : null;
}

/**
 * 从市场下载并安装/更新某插件（`ms.market.install/update` 与宿主 UI 更新按钮共用）。
 *
 * **必经用户确认**：下载并解包后、落盘前，先调用 `confirmPluginInstall` 弹安装确认框；
 * 用户取消即返回 `{ ok: false, cancelled: true }`，磁盘与注册表原封不动（fail-closed）。
 */
export async function updatePluginFromMarket(
  id: string,
  action: "install" | "update",
  confirmPluginInstall: NonNullable<PluginHostContext["confirmPluginInstall"]>
): Promise<{ ok: true; version: string } | { ok: false; error?: string; cancelled?: boolean }> {
  const { marketFetchRaw, installPluginPackage } = await import("../ipc.ts");
  const { parseCatalog } = await import("../market-types.ts");
  const { clearUpdateAvailable } = await import("../market.ts");
  const catalogRaw = await marketFetchRaw(MARKET_PLUGIN_ID, MARKET_CATALOG_URL, "");
  const parsed = parseCatalog(new TextDecoder("utf-8").decode(catalogRaw));
  const entry = parsed.ok ? parsed.catalog.plugins.find((e) => e.id === id) : null;
  if (!entry) return { ok: false as const, error: `市场中未找到插件: ${id}` };

  const pkgUrl = entry.downloadUrl;
  const b64 = await marketFetchRaw(MARKET_PLUGIN_ID, pkgUrl, entry.sha256);
  const { preparePackage } = await import("../install.ts");
  const prepared = await preparePackage(b64, {
    hostVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
    checkPermissions: isKnownPermission,
  });

  const mf = prepared.manifest;
  const existingRec = findPlugin(loadRegistry(), mf.id);
  const installedVersion = existingRec?.version ?? null;
  // 安装/重装时直接按插件清单声明初始化开关（声明 autoUpdate: true 即默认开启，用户可手动关掉）；
  // 升级时经 resolveInstallDialogAutoUpdate 计算（旧版未声明而新版声明 true 时同样默认开启）。
  let chosenAutoUpdate = resolveInstallDialogAutoUpdate({
    action,
    existing: existingRec,
    nextManifest: mf,
  });
  let running = false;
  if (installedVersion) {
    try {
      const { listPluginBackends } = await import("../ipc.ts");
      const st = (await listPluginBackends()).find((s) => s.pluginId === mf.id)?.status;
      running = st === "running" || st === "starting";
    } catch {
      /* 浏览器调试或无 Rust 侧 */
    }
  }

  const confirmed = await confirmPluginInstall({
    manifest: mf,
    iconUrl: iconUrlOf(prepared),
    permBlocks: groupPermissions([...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])]),
    warnings: prepared.warnings,
    installedVersion,
    action,
    running,
    autoUpdate: chosenAutoUpdate,
    onAutoUpdateChange: (next) => {
      chosenAutoUpdate = Boolean(next);
    },
  });
  if (!confirmed) return { ok: false as const, cancelled: true };

  const allPerms = [...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])];
  await installPluginPackage(id, prepared.files);
  const reg = loadRegistry();
  const record = createPluginRecord({
    manifest: mf,
    dir: `plugins/${id}`,
    source: { kind: "market", ref: pkgUrl },
    grants: allPerms,
    autoUpdate: chosenAutoUpdate,
    integrity: { sha256: prepared.sha256, signed: false },
  });
  upsertPlugin(reg, record, {
    preserveUserChoices: action === "update",
    explicitAutoUpdate: chosenAutoUpdate,
  });
  clearUpdateAvailable(reg, id);
  saveRegistry(reg);

  if (action === "update") {
    try {
      const { markPluginFrontendRestart } = await import("../restart.ts");
      markPluginFrontendRestart(id);
    } catch (e) {
      console.warn("[插件市场] 写前端重启标记失败:", e);
    }
  }
  try {
    const { syncRecordGateway } = await import("../gateway.ts");
    const merged = findPlugin(loadRegistry(), id);
    if (merged) await syncRecordGateway(merged);
  } catch (e) {
    console.warn("[插件市场] 安装后网关同步失败:", e);
  }
  try {
    const { syncShortcutActions } = await import("../gateway.ts");
    await syncShortcutActions(reg);
  } catch (e) {
    console.warn("[插件市场] 快捷键动作同步失败:", e);
  }
  return { ok: true as const, version: mf.version };
}

export function createMarketApi(
  pluginId: string,
  call: CallRunner,
  ctx: PluginHostContext
): Record<string, unknown> {
  function guarded<T>(name: string, run: () => T | Promise<T>): T | Promise<T> {
    return call({ api: `market.${name}`, permission: "plugin.install", run: () => run() });
  }

  const self: Record<string, unknown> = {};

  async function catalogFetch() {
    const { marketFetchRaw } = await import("../ipc.ts");
    const { compatibleEntries, parseCatalog } = await import("../market-types.ts");
    const { diffCatalog, applyUpdateAvailable } = await import("../market.ts");
    const reg = loadRegistry();
    const raw = await marketFetchRaw(pluginId, MARKET_CATALOG_URL, "");
    const text = new TextDecoder("utf-8").decode(raw);
    const parsed = parseCatalog(text);
    if (!parsed.ok) return null;
    const compat = compatibleEntries(
      parsed.catalog,
      typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : ""
    );
    const diff = diffCatalog(reg, compat);
    applyUpdateAvailable(reg, diff);
    return { reg, catalog: parsed.catalog, diff };
  }

  async function buildMarketView(result: NonNullable<Awaited<ReturnType<typeof catalogFetch>>>) {
    const { pluginRepoUrl } = await import("../market-types.ts");
    const installedMap: Record<string, string> = {};
    for (const rec of result.reg.plugins) {
      if (rec.source.kind === "builtin" || rec.source.kind === "market") {
        installedMap[rec.id] = rec.version;
      }
    }
    return {
      entries: result.catalog.plugins.map((e) => ({ ...e, repoUrl: pluginRepoUrl(e) })),
      installedMap,
      updates: result.diff.updates.map((u) => ({
        id: u.rec.id,
        currentVersion: u.rec.version,
        availableVersion: u.entry.version,
        changelog: u.entry.changelog,
        repoUrl: pluginRepoUrl(u.entry),
      })),
      blocked: result.diff.blocked.map((b) => b.id),
      error: null as string | null,
    };
  }

  /**
   * 市场安装与更新统一必经用户确认入口（fail-closed：未注入确认框时直接拒绝）。
   */
  async function installOrUpdate(id: string, action: "install" | "update") {
    if (!ctx.confirmPluginInstall) {
      return {
        ok: false as const,
        error:
          action === "update"
            ? "当前窗口不支持安装确认，已取消更新"
            : "当前窗口不支持安装确认，已取消安装",
      };
    }
    return await updatePluginFromMarket(id, action, ctx.confirmPluginInstall);
  }

  self.list = () =>
    guarded("list", async () => {
      const result = await catalogFetch();
      if (!result) {
        return { entries: [], installedMap: {}, updates: [], blocked: [], error: "解析目录失败" };
      }
      return buildMarketView(result);
    });

  self.install = (id: string) =>
    guarded("install", () => installOrUpdate(id, "install"));

  self.update = (id: string) =>
    guarded("update", async () => {
      const result = await installOrUpdate(id, "update");
      return result.ok ? { ok: true as const, updatedTo: result.version } : result;
    });

  self.uninstall = (id: string) =>
    guarded("uninstall", async () => {
      const { removePluginDir, stopPluginBackend } = await import("../ipc.ts");
      const { removePlugin } = await import("../registry.ts");
      const rec = findPlugin(loadRegistry(), id);
      if (!rec || rec.manifest.backend) {
        try {
          await stopPluginBackend(id);
        } catch (e) {
          console.warn(`[插件市场] 卸载前停止后台进程失败（${id}）:`, e);
        }
      }
      disposePluginHostSession(id);
      await removePluginDir(id);
      const reg = loadRegistry();
      removePlugin(reg, id);
      saveRegistry(reg);
      try {
        const { syncShortcutActions } = await import("../gateway.ts");
        await syncShortcutActions(reg);
      } catch (e) {
        console.warn("[插件市场] 快捷键动作同步失败:", e);
      }
      return { ok: true };
    });

  self.checkUpdates = () =>
    guarded("checkUpdates", async () => {
      const result = await catalogFetch();
      if (!result) return 0;
      const { updateableCount } = await import("../market.ts");
      return updateableCount(result.reg);
    });

  self.refreshCatalog = () =>
    guarded("refreshCatalog", async () => {
      const result = await catalogFetch();
      if (!result) {
        return { entries: [], installedMap: {}, updates: [], blocked: [], error: null };
      }
      return buildMarketView(result);
    });

  return self;
}
