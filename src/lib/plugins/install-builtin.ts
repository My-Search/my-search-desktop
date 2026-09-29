/**
 * 内置插件自动安装 —— 在搜索窗口 / 配置窗启动时，把内置插件装好。
 *
 * 设计（计划 §7 P1）：
 *   - Rust 侧只做白名单路由与 removed 标记，不解包；
 *   - 前端拿到资源路径后，走 `readLocalFileBase64 → preparePackageFromBase64 →
 *     installPluginPackage → 写入注册表` 完成安装；
 *   - 权限直接授予 `manifest.permissions`（白名单内置插件属「免确认」通道）；
 *   - 跨窗口幂等：每项安装后写注册表，窗口间共享 localStorage，重复触发不重装。
 *
 * ## 内容变更时的重装（v7.9.16 起）
 *
 * 只判「是否已安装」会让随应用升级更新的内置插件在**已装用户**身上永不生效：
 * 落盘副本 `plugins/<id>/` 还是旧的界面文件（真实踩到过：源码 CSS 改好了、
 * 页面照旧）。因此启动时额外比对**内容指纹**（见 `packageContentFingerprint`）：
 * 与记录里的 `builtinFingerprint` 不一致就重装一次。重装只覆盖文件与清单派生
 * 字段，用户态（enabled / autoStart / closeBehavior / 已授权权限）一律保留
 * （走 `upsertPlugin` 的默认保留路径）。
 */

import { builtinResourcePath, onBuiltinAvailable, type BootstrapReport, builtinList } from "./builtin.ts";
import { isTauri } from "../tauri-bridge.ts";
import { readLocalFileBase64, installPluginPackage, readPluginText, installPluginFromDir, watchPluginDir, readDevManifest } from "./ipc.ts";
import { packageContentFingerprint, preparePackageFromBase64 } from "./install.ts";
import { parsePluginManifest } from "./manifest.ts";
import { isKnownPermission } from "./permissions.ts";
import { planReload } from "./dev-reload.ts";
import {
  createPluginRecord,
  upsertPlugin,
  loadRegistry,
  saveRegistry,
  type PluginRecord,
} from "./registry.ts";

/** 一个窗口内「内置安装中」的 id 集合（防止重复并发） */
const installing = new Set<string>();

/**
 * 重读清单后，记录里是否有**值得写回**的变化。
 *
 * 只比清单派生出来的那几项：版本 / 名称 / 描述 / 图标 / 界面入口 / 后台入口 /
 * 自启建议 / 关界面行为 / 主题偏好。清单里改任何一项都可能影响行为，因此逐项比；
 * 一律没变就跳过，避免每次启动都重写注册表并重放网关同步。
 *
 * 导出供测试直测（启动路径依赖 IPC 读文件，纯判定部分单独覆盖）。
 */
export function manifestChanged(prev: PluginRecord, next: PluginRecord): boolean {
  const a = JSON.stringify({
    v: prev.version,
    n: prev.name,
    d: prev.description,
    i: prev.icon,
    m: prev.manifest,
    s: prev.autoStart,
    c: prev.closeBehavior,
    t: prev.themePreference,
  });
  const b = JSON.stringify({
    v: next.version,
    n: next.name,
    d: next.description,
    i: next.icon,
    m: next.manifest,
    s: next.autoStart,
    c: next.closeBehavior,
    t: next.themePreference,
  });
  return a !== b;
}

/**
 * 把一个内置插件挂载为**本地源码目录**（开发模式专用）。
 *
 * 为什么不直接复用配置窗的「从目录挂载」：那条路径在 `usePluginRuntime`（配置窗）
 * 里，依赖配置窗的响应式状态与 reconcile；而内置插件的自动安装要在**搜索窗与配置窗
 * 都可能触发**（`setupBuiltinAutoInstall`），因此这里做成无状态、可重入的自包含版本。
 *
 * 幂等：已挂载到同一个 `devSource` 时直接返回 false（只在首次或源目录变了时动作）。
 *
 * 步骤（与手动「从目录挂载」完全同构）：
 *   1. 读源目录清单并校验（parsePluginManifest）；
 *   2. `installPluginFromDir` → Rust 写 `.dev-source` 指向源目录；
 *   3. upsert 记录为 `source: { kind: "folder", ref: dir, dev: true }`，保留用户态；
 *   4. `watchPluginDir` 登记监听 → 改源码即热重载。
 */
async function installBuiltinDevMount(id: string, dir: string): Promise<boolean> {
  const registry = loadRegistry();
  const prev = registry.plugins.find((p) => p.id === id);
  // 已挂载到同一个源码目录：幂等，什么都不做
  if (prev && prev.source.kind === "folder" && prev.source.dev === true && prev.source.ref === dir) {
    return false;
  }

  // 读源目录里的 plugin.json（Rust 侧的 plugin_read_dev_manifest）
  let manifestText: string;
  try {
    manifestText = await readDevManifest(dir);
  } catch (e) {
    console.warn(`[内置插件] 读取开发清单失败，回退到内置包：${id}`, e);
    return false;
  }
  const parsed = parsePluginManifest(manifestText, isKnownPermission);
  if (!parsed.ok) {
    console.warn(`[内置插件] 开发清单校验失败，回退到内置包：${id}`, parsed.errors);
    return false;
  }
  // 目录里的 id 必须与内置 id 一致，否则拒绝（防错挂）
  if (parsed.manifest.id !== id) {
    console.warn(`[内置插件] 开发目录 id 不匹配（期望 ${id}，实际 ${parsed.manifest.id}），跳过挂载`);
    return false;
  }

  try {
    await installPluginFromDir(id, dir);
  } catch (e) {
    console.warn(`[内置插件] 目录挂载失败，回退到内置包：${id}`, e);
    return false;
  }

  const record = createPluginRecord({
    manifest: parsed.manifest,
    dir,
    source: { kind: "folder", ref: dir, dev: true },
    grants: [...(parsed.manifest.permissions ?? []), ...(parsed.manifest.optionalPermissions ?? [])],
    integrity: { sha256: null, signed: false },
  });
  upsertPlugin(registry, record, { preserveUserChoices: true });
  saveRegistry(registry);

  // 登记源目录监听：改源码即自动重载（失败只提示，不影响挂载本身）
  try {
    await watchPluginDir(id, dir, true);
  } catch (e) {
    console.warn(`[内置插件] 登记目录监听失败（已挂载，但不会自动重载）: ${id}`, e);
  }
  console.log(`[内置插件] 开发模式已挂载源码目录: ${id} → ${dir}`);
  return true;
}

/**
 * 安装 / 刷新单个内置插件。
 *
 * - **开发模式且能找到源码目录**（`entry.devSource` 非空）：改为**目录挂载**
 *   （`source.kind === "folder" && dev`），走本地 `plugins/<name>/` 源码，
 *   编辑即时生效、无需重新打包 .mspp（返回 true）——详见 `installBuiltinDevMount`；
 * - 未安装：从内置包装（返回 true，来源记为 builtin）；
 * - 已**内置安装**但**内容指纹变了**（随应用升级更新了内置插件）：静默重装
 *   （返回 true，用户态保留）；
 * - 已内置安装且内容一致：什么都不做（返回 false，幂等）；
 * - 已安装但来源**不是内置**（用户从市场 / 从文件装过同名插件）：一律不碰——
 *   尊重用户装的那个版本，内置包不覆盖它（与 Rust 侧 bootstrap「装了即跳过」同一口径）。
 */
async function installSingleBuiltin(id: string): Promise<boolean> {
  if (installing.has(id)) return false;
  installing.add(id);
  try {
    const entries = await builtinList();
    const entry = entries.find((e) => e.id === id);
    // 开发模式：优先目录挂载本地源码（比内置包更能反映当前开发状态）。
    // 注意：devSource 存在时即使 `.mspp` 资源未打包（available=false）也要挂载——
    // 开发时往往只想跑源码，不先跑 pack:builtin。
    if (entry && !entry.removed && entry.devSource) {
      return await installBuiltinDevMount(id, entry.devSource);
    }

    if (!entry || !entry.available || entry.removed) return false;

    const registry = loadRegistry();
    const prev = registry.plugins.find((p) => p.id === id);
    // 已装（无论来源）但装的不是内置版：尊重用户那一个，不覆盖
    if (prev && prev.source.kind !== "builtin") return false;

    const resourcePath = entry.resourcePath!;
    const base64 = await readLocalFileBase64(resourcePath);
    const prepared = await preparePackageFromBase64(base64);
    const fingerprint = await packageContentFingerprint(prepared.files);

    // 已内置安装且内容没变：不动（绝大多数启动的情况）
    if (prev && prev.builtinFingerprint === fingerprint) return false;

    // IPC 落盘（Rust 侧是 staging → 校验 → 原子替换，失败不破坏旧版本）
    await installPluginPackage(id, prepared.files);

    const record = createPluginRecord({
      manifest: prepared.manifest,
      dir: "", // 内置插件的 dir 由 Rust 侧管理
      source: { kind: "builtin" },
      grants: [...(prepared.manifest.permissions ?? []), ...(prepared.manifest.optionalPermissions ?? [])],
      integrity: { sha256: prepared.sha256, signed: false },
    });
    record.builtinFingerprint = fingerprint;
    // prev 存在 = 内容变更刷新：保留用户态（enabled / autoStart / closeBehavior / 授权）
    upsertPlugin(registry, record, { preserveUserChoices: true });
    saveRegistry(registry);

    if (prev) console.log(`[内置插件] 内容已更新，已刷新: ${id}`);
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

  /** 启动时修补已挂载 dev 插件缺失的 optionalPermissions（旧版目录挂载没授予它们） */
  function fixupDevGrants() {
    try {
      const registry = loadRegistry();
      let changed = false;
      for (const rec of registry.plugins) {
        if (!rec.source.dev) continue;
        const opts = rec.manifest.optionalPermissions ?? [];
        for (const p of opts) {
          if (!rec.grants.some((g: any) => g.permission === p)) {
            rec.grants.push({ permission: p, at: Date.now(), source: "install" });
            changed = true;
          }
        }
      }
      if (changed) saveRegistry(registry);
    } catch (e) {
      console.warn("[内置插件] 修复 dev 挂载权限失败:", e);
    }
  }

  /**
   * 启动时重读目录挂载插件的 `plugin.json`，把清单变更应用到记录上。
   *
   * **为什么需要**：目录挂载的插件靠 Rust 侧文件监听（`plugin://dev-changed`）
   * 热重载，但监听只在**应用运行期间**有效。作者在应用关闭时改了清单
   * （改默认热键、改自启策略、加权限），重启后没有任何事件来触发重载，
   * 记录里还是旧清单——表现就是「改了 plugin.json 却毫无反应」，只能删了重挂。
   *
   * 复用热重载那套纯函数 `planReload`：清单读不出来（目录被删/半截 JSON）就跳过、
   * 用户态一律保留、新权限只登记待授权，不做任何静默授予。
   *
   * 只处理「清单确实变了」的插件（其余直接跳过，不产生多余写入与网关同步）。
   */
  async function refreshDevManifests() {
    if (!isTauri) return;
    try {
      const registry = loadRegistry();
      let changed = false;
      for (const rec of registry.plugins) {
        if (!rec.source.dev || !rec.source.ref) continue;
        let manifestText: string;
        try {
          manifestText = await readPluginText(rec.id, "plugin.json");
        } catch {
          continue; // 源目录不可读（改名/删除）：保留旧记录，等用户处理
        }
        const plan = planReload(rec, manifestText);
        if (!plan.proceed) continue;
        // 只在**真的变了**的时候写回：planReload 对内容相同的清单也会成功返回，
        // 无条件写回会让每次启动都重写注册表并重放一遍网关同步（多余且有副作用）。
        // 比对的字段覆盖清单里会派生出行为的那几项（版本/自启/权限/入口）。
        if (!manifestChanged(rec, plan.record) && plan.newPermissions.length === 0) continue;
        const idx = registry.plugins.findIndex((p) => p.id === rec.id);
        if (idx >= 0) registry.plugins[idx] = plan.record;
        changed = true;
        console.log(`[插件] 启动时重读清单：${rec.id} → v${plan.record.version}`);
      }
      if (changed) saveRegistry(registry);
    } catch (e) {
      console.warn("[插件] 启动时重读 dev 清单失败:", e);
    }
  }

  /**
   * 拉取当前 bootstrap 状态并处理内置插件。
   *
   * 不再自己判 `installed`：是否需要动作（未装 / 内容变了）由
   * `installSingleBuiltin` 用内容指纹决定——只判「已装就跳过」会让随版本
   * 更新的内置插件在已装用户身上永不生效。
   */
  async function pullAndInstall() {
    try {
      const entries = await builtinList();
      for (const e of entries) {
        if (e.removed) continue;
        // 开发挂载：即使未打包 .mspp（available=false）也要处理源码目录
        if (!e.available && !e.devSource) continue;
        const ok = await installSingleBuiltin(e.id);
        if (ok) console.log(`[内置插件] 已安装/已刷新: ${e.id}`);
      }
    } catch (err) {
      console.warn("[内置插件] 拉取安装失败:", err);
    }
  }

  // 0) 修补已装内置插件缺失的 optionalPermissions
  await fixupBuiltinGrants();

  // 0.5) 修补已挂载 dev 插件缺失的 optionalPermissions
  fixupDevGrants();

  // 0.6) 重读 dev 插件清单：应用关闭期间改的 plugin.json 靠这一步才生效
  await refreshDevManifests();

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