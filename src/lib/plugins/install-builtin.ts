/**
 * 内置插件自动安装 —— 在搜索窗口 / 配置窗启动时，把「应装未装」的内置插件
 * 通过既有安装管线装好。
 *
 * 设计（计划 §7 P1）：
 *   - Rust 侧只做白名单路由与 removed 标记，不解包；
 *   - 前端拿到资源路径后，走 `readLocalFileBase64 → preparePackageFromBase64 →
 *     installPluginPackage → 写入注册表` 完成安装；
 *   - 权限直接授予 `manifest.permissions`（白名单内置插件属「免确认」通道）；
 *   - 跨窗口幂等：每项安装后写注册表，窗口间共享 localStorage，重复触发不重装。
 */

import { builtinResourcePath, onBuiltinAvailable, type BootstrapReport, builtinList } from "./builtin.ts";
import { isTauri } from "../tauri-bridge.ts";
import { readLocalFileBase64, installPluginPackage } from "./ipc.ts";
import { preparePackageFromBase64, type InstallFilePayload } from "./install.ts";
import {
  createPluginRecord,
  upsertPlugin,
  loadRegistry,
  saveRegistry,
} from "./registry.ts";

/** 一个窗口内「内置安装中」的 id 集合（防止重复并发） */
const installing = new Set<string>();

/**
 * 安装单个内置插件（幂等：注册表已存在时跳过）。
 */
async function installSingleBuiltin(id: string): Promise<boolean> {
  if (installing.has(id)) return false;
  installing.add(id);
  try {
    const entries = await builtinList();
    const entry = entries.find((e) => e.id === id);
    if (!entry || !entry.available || entry.installed || entry.removed) return false;

    const resourcePath = entry.resourcePath!;
    const base64 = await readLocalFileBase64(resourcePath);
    const prepared = await preparePackageFromBase64(base64);

    // IPC 落盘
    await installPluginPackage(id, prepared.files);

    // 写注册表
    const registry = loadRegistry();
    const record = createPluginRecord({
      manifest: prepared.manifest,
      dir: "", // 内置插件的 dir 由 Rust 侧管理
      source: { kind: "builtin" },
      grants: [...(prepared.manifest.permissions ?? []), ...(prepared.manifest.optionalPermissions ?? [])],
      integrity: { sha256: prepared.sha256, signed: false },
    });
    upsertPlugin(registry, record, { preserveUserChoices: false });
    saveRegistry(registry);

    return true;
  } finally {
    installing.delete(id);
  }
}

/**
 * 注册内置插件的自动安装（启动时拉取 + 监听事件兜底）。
 *
 * @returns 取消监听的函数
 */
export async function setupBuiltinAutoInstall(): Promise<() => void> {
  if (!isTauri) return () => {};

  /** 启动时修补已装内置插件的 optionalPermissions（旧版安装没授予它们） */
  async function fixupBuiltinGrants() {
    try {
      const entries = await builtinList();
      for (const entry of entries) {
        if (!entry.installed || !entry.resourcePath) continue;
        const b64 = await readLocalFileBase64(entry.resourcePath);
        const prepared = await preparePackageFromBase64(b64);
        const opts = prepared.manifest.optionalPermissions ?? [];
        if (opts.length === 0) continue;
        const registry = loadRegistry();
        const rec = registry.plugins.find((p) => p.id === entry.id);
        if (!rec) continue;
        let changed = false;
        for (const p of opts) {
          if (!rec.grants.some((g: any) => g.permission === p)) {
            rec.grants.push({ permission: p, at: Date.now(), source: "install" });
            changed = true;
          }
        }
        if (changed) saveRegistry(registry);
      }
    } catch (e) {
      console.warn("[内置插件] 修复权限失败:", e);
    }
  }

  /** 拉取当前 bootstrap 状态并安装应装未装的插件 */
  async function pullAndInstall() {
    try {
      const entries = await builtinList();
      for (const e of entries) {
        if (!e.available || e.installed || e.removed) continue;
        const ok = await installSingleBuiltin(e.id);
        if (ok) {
          console.log(`[内置插件] 已安装: ${e.id}`);
        }
      }
    } catch (err) {
      console.warn("[内置插件] 拉取安装失败:", err);
    }
  }

  // 0) 修补已装内置插件缺失的 optionalPermissions
  await fixupBuiltinGrants();

  // 1) 主动拉取（克服 setup emit 早于前端监听导致事件丢失）
  await pullAndInstall();

  // 2) 被动监听（后续窗口加载 / 事件重发）
  const unlisten = onBuiltinAvailable((report: BootstrapReport) => {
    for (const id of report.installable) {
      installSingleBuiltin(id).then((ok) => {
        if (ok) console.log(`[内置插件] 事件触发已安装: ${id}`);
      }).catch((err) => {
        console.warn(`[内置插件] 自动安装 ${id} 失败:`, err);
      });
    }
  });

  return unlisten;
}