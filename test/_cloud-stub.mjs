/**
 * 云同步 v2 内核的**内存桩**：只实现内核用到的少数 IPC 与落盘语义，
 * 让 `src/lib/sync/cloud.ts` 能完全离线、确定性地跑完整轮次。
 *
 * 桩的关键约定：**同一个分片内容的摘要只由「内容」决定**（这里用确定性的字符串
 * 摘要模拟），上传返回的摘要与 `cloudDigests` 算出的摘要必须一致——否则测试里
 * 的基线会互相打架，测不出真实行为。
 */

export const __cloud = {
  enabled: true,
  config: {
    enabled: true,
    webdavUrl: "https://example.com/dav/",
    webdavUser: "u",
    remoteFile: "my-search-backup.msbackup",
    conflict: "newer",
    autoOnChange: true,
    intervalMinutes: 30,
    hasPassword: true,
  },
  state: {
    deviceId: "dev-a",
    target: "",
    initialized: false,
    remoteRev: "",
    remoteEtag: "",
    lastLocalDigest: "",
    lastSyncAt: 0,
    appliedRev: "",
    epoch: 1,
    cloudFormat: 0,
    manifestEtag: "",
    shards: null,
    pending: null,
  },
  /** 本机态 */
  local: {
    core: { keyA: 1 },
    pluginLs: {},
    bodyFiles: {},
    dataFiles: {},
    settings: { a: 1 },
  },
  /** 远端态 */
  manifest: null,
  etagSeq: 0,
  objects: new Map(), // rel -> { ls, files, kind, pluginId }
  pendingApply: null,
  legacy: { exists: false, etag: "" },
  applied: [],
  restoreCount: 0,
  puts: [],
  gets: [],
};

function hash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function pluginIds() {
  return Array.from(
    new Set([
      ...Object.keys(__cloud.local.bodyFiles),
      ...Object.keys(__cloud.local.dataFiles),
    ])
  );
}

export async function cloudDigests(localStorage) {
  const plugins = {};
  const coreLs = localStorage?.core ?? __cloud.local.core;
  const extraPluginLs = localStorage?.plugins ?? {};
  for (const id of pluginIds()) {
    const files = __cloud.local.bodyFiles[id] ?? 0;
    const dataFiles = __cloud.local.dataFiles[id] ?? 0;
    const dataLs = { ...(__cloud.local.pluginLs[id] ?? {}), ...(extraPluginLs[id] ?? {}) };
    plugins[id] = {
      body: { digest: files > 0 ? `body-${id}-${files}-${hash(__cloud.local.bodyFiles[id])}` : "", bytes: files * 11, files },
      data: {
        digest: `data-${id}-${hash(dataLs)}-${dataFiles}`,
        bytes: dataFiles * 7 + 3,
        files: dataFiles,
      },
    };
  }
  return {
    core: { digest: `core-${hash(coreLs)}-${hash(__cloud.local.settings)}`, bytes: 9, files: 1 },
    plugins,
    appVersion: "9.9.9-test",
    at: 1,
  };
}

export async function cloudManifestGet() {
  return {
    exists: !!__cloud.manifest,
    etag: `"etag-${__cloud.etagSeq}"`,
    rev: String(__cloud.etagSeq),
    size: 0,
    modified: Date.now(),
    manifest: __cloud.manifest ? JSON.parse(JSON.stringify(__cloud.manifest)) : null,
  };
}

export async function cloudManifestPut(manifest, ifMatch) {
  // 测试钩子：模拟「提交前别的设备抢先提交了一次」
  if (__cloud.foreignCommit) {
    const fn = __cloud.foreignCommit;
    __cloud.foreignCommit = null;
    fn(__cloud);
    throw new Error("SYNC_CONFLICT: 远端 manifest 已被其他设备修改");
  }
  // 模拟条件提交：传入的 etag 不是当前版本 → 412
  const current = `"etag-${__cloud.etagSeq}"`;
  if (ifMatch && ifMatch !== current) {
    throw new Error("SYNC_CONFLICT: 远端 manifest 已被其他设备修改");
  }
  if (!ifMatch && __cloud.manifest) {
    throw new Error("SYNC_CONFLICT: 远端 manifest 已被其他设备修改");
  }
  __cloud.etagSeq += 1;
  __cloud.manifest = JSON.parse(JSON.stringify(manifest));
  return { ok: true, etag: `"etag-${__cloud.etagSeq}"`, rev: String(manifest.rev), size: 0, modified: Date.now() };
}

export async function cloudQuota() {
  return { pluginBytes: 200 * 1024 * 1024, shardBytes: 200 * 1024 * 1024 };
}

export async function cloudShardPut(scope, ls) {
  let digest = "";
  let pluginId = "";
  let rel = "";
  let files = 0;
  if (scope === "core") {
    digest = `core-${hash(ls)}-${hash(__cloud.local.settings)}`;
    rel = `core-${digest}.msbackup`;
  } else {
    const kind = scope.startsWith("body:") ? "body" : "data";
    pluginId = scope.slice(kind.length + 1);
    if (kind === "body") {
      files = __cloud.local.bodyFiles[pluginId] ?? 0;
      digest = files > 0 ? `body-${pluginId}-${files}-${hash(__cloud.local.bodyFiles[pluginId])}` : "";
    } else {
      files = __cloud.local.dataFiles[pluginId] ?? 0;
      digest = `data-${pluginId}-${hash(ls)}-${files}`;
    }
    rel = `plugins/${pluginId}/${kind}-${digest}.msbackup`;
  }
  __cloud.puts.push({ scope, digest, rel });
  __cloud.objects.set(rel, { ls, files, kind: scope === "core" ? "core" : scope.split(":")[0], pluginId });
  return { rel, digest, bytes: 12, uploaded: true, pluginId };
}

export async function cloudShardGet(rel) {
  const obj = __cloud.objects.get(rel);
  if (!obj) throw new Error(`CLOUD_NOT_FOUND: ${rel}`);
  __cloud.gets.push({ rel, obj });
  __cloud.pendingApply = obj;
  return { path: `/fake/${rel}`, bytes: 12, rev: "1", etag: '"e"', rel };
}

/** 与真实命令同形：列出分片内的条目（面板「查看内容」用） */
export async function cloudShardInspect(rel) {
  const obj = __cloud.objects.get(rel);
  if (!obj) throw new Error(`CLOUD_NOT_FOUND: ${rel}`);
  const count = typeof obj.files === "number" ? obj.files : 0;
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({ name: `${obj.kind}/file-${i + 1}`, size: 1 });
  }
  return { rel, bytes: 12, totalBytes: count, entries, truncated: false };
}

export async function syncGetConfig() {
  return { ...__cloud.config, enabled: __cloud.enabled };
}

export async function syncStateGet() {
  return JSON.parse(JSON.stringify(__cloud.state));
}

export async function syncStatePatch(patch) {
  Object.assign(__cloud.state, patch);
  return JSON.parse(JSON.stringify(__cloud.state));
}

export async function syncRemoteMeta() {
  return { exists: __cloud.legacy.exists, rev: __cloud.legacy.etag, etag: __cloud.legacy.etag, modified: 1, size: 1 };
}

export async function syncDownload() {
  return { path: "/fake/legacy.msbackup", size: 1, rev: "1", etag: '"l"', modified: 1, notModified: false };
}

export async function backupSnapshot(_localStorage, prefix = "snapshot-") {
  __cloud.snapshots = (__cloud.snapshots ?? 0) + 1;
  return `C:\\backups\\${prefix}${__cloud.snapshots}.msbackup`;
}

export async function backupRestore() {
  __cloud.restoreCount += 1;
  const obj = __cloud.pendingApply;
  if (obj?.kind === "core" && obj.ls) {
    __cloud.local.core = { ...obj.ls };
    return { localStorage: { ...obj.ls }, scope: "all", downgradeSkipped: [] };
  }
  // 插件数据
  const ls = obj?.ls ?? {};
  const pid = obj?.pluginId;
  __cloud.local.pluginLs[pid] = { ...ls };
  return { localStorage: { ...ls }, scope: "plugins", downgradeSkipped: [] };
}

export async function backupRestorePluginShard(_path, pluginId) {
  __cloud.restoreCount += 1;
  const obj = __cloud.pendingApply;
  if (obj?.files !== undefined) __cloud.local.bodyFiles[pluginId] = obj.files;
  return { pluginId, files: 1, skipped: false };
}

export async function syncCommitApplied(source, scope) {
  __cloud.applied.push({ source, scope });
  __cloud.state.epoch = (__cloud.state.epoch ?? 1) + 1;
  return __cloud.state.epoch;
}

/* ---------- `./snapshot` 桩 ---------- */

export function collectState() {
  const out = { ...__cloud.local.core };
  for (const obj of Object.values(__cloud.local.pluginLs)) {
    for (const [k, v] of Object.entries(obj)) out[k] = v;
  }
  return out;
}

/** 覆盖前留底走同一份内存态（测试只关心「有没有留底」，不关心过滤口径） */
export function collectBackupState() {
  return collectState();
}

export function splitStateByShard(state = collectState()) {
  const core = {};
  const plugins = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("PLUGIN_DATA:")) {
      const rest = k.slice("PLUGIN_DATA:".length);
      const sep = rest.indexOf(":");
      if (sep > 0) {
        const id = rest.slice(0, sep);
        (plugins[id] ??= {})[k] = v;
        continue;
      }
    }
    core[k] = v;
  }
  return { core, plugins };
}

export function restoreState(data) {
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("PLUGIN_DATA:")) {
      const rest = k.slice("PLUGIN_DATA:".length);
      const sep = rest.indexOf(":");
      if (sep > 0) {
        const id = rest.slice(0, sep);
        (__cloud.local.pluginLs[id] ??= {})[k] = v;
      }
    } else {
      __cloud.local.core[k] = v;
    }
  }
  return Object.keys(data).length;
}

/* ---------- v3 桩（v2 测试不会走到；v3 测试单独驱动） ---------- */

__cloud.v3 = {
  manifest: null,
  etagSeq: 0,
  foreignCommit: null,
  local: { core: {}, plugins: {} }, // { [id]: { files: {path: value}, blobs: {path: value}, state: {} } }
  objects: new Map(), // digest -> value
  puts: [],
  gets: [],
  applied: [],
  deleted: [],
};

function v3Digest(value) {
  return `v3-${hash(value)}`;
}

function v3Plugins() {
  return Object.keys(__cloud.v3.local.plugins);
}

export async function cloudManifestV3Get() {
  return {
    exists: !!__cloud.v3.manifest,
    etag: `"v3-etag-${__cloud.v3.etagSeq}"`,
    rev: String(__cloud.v3.etagSeq),
    size: 0,
    modified: Date.now(),
    manifest: __cloud.v3.manifest ? JSON.parse(JSON.stringify(__cloud.v3.manifest)) : null,
  };
}

export async function cloudManifestV3Put(manifest, ifMatch) {
  if (__cloud.v3.foreignCommit) {
    const fn = __cloud.v3.foreignCommit;
    __cloud.v3.foreignCommit = null;
    fn(__cloud);
    throw new Error("SYNC_CONFLICT: 远端 manifest-v3 已被其他设备修改");
  }
  const current = `"v3-etag-${__cloud.v3.etagSeq}"`;
  if (ifMatch && ifMatch !== current) throw new Error("SYNC_CONFLICT: 远端 manifest-v3 已被其他设备修改");
  if (!ifMatch && __cloud.v3.manifest) throw new Error("SYNC_CONFLICT: 远端 manifest-v3 已被其他设备修改");
  __cloud.v3.etagSeq += 1;
  __cloud.v3.manifest = JSON.parse(JSON.stringify(manifest));
  return { ok: true, etag: `"v3-etag-${__cloud.v3.etagSeq}"`, rev: String(manifest.rev), size: 0, modified: Date.now() };
}

export async function cloudV3Scan(localStorage) {
  const plugins = {};
  for (const id of v3Plugins()) {
    const p = __cloud.v3.local.plugins[id];
    const state = { ...(__cloud.local.pluginLs[id] ?? {}), ...(localStorage?.plugins?.[id] ?? {}) };
    const files = Object.entries(p.files ?? {}).map(([path, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return {
        path,
        digest: v3Digest(value),
        bytes: text.length,
        ...(text.length <= 2048 ? { inline: text } : {}),
      };
    });
    const blobs = Object.entries(p.blobs ?? {}).map(([path, value]) => ({
      path,
      digest: v3Digest(value),
      bytes: String(value).length,
    }));
    const bodyFiles = __cloud.local.bodyFiles[id] ?? 0;
    plugins[id] = {
      body: {
        digest: bodyFiles ? `body-${id}-${bodyFiles}-${hash(__cloud.local.bodyFiles[id])}` : "",
        bytes: bodyFiles * 11,
        files: bodyFiles,
      },
      state,
      files,
      blobs,
    };
  }
  return {
    core: { digest: `core-${hash(__cloud.local.core)}-${hash(__cloud.local.settings)}`, bytes: 9, files: 1 },
    plugins,
    appVersion: "9.9.9-test",
    at: 1,
  };
}

export async function cloudV3FilePut(pluginId, rel) {
  const value = __cloud.v3.local.plugins[pluginId]?.files?.[rel];
  if (value === undefined) throw new Error(`文件不存在: ${pluginId}/${rel}`);
  const digest = v3Digest(value);
  __cloud.v3.objects.set(digest, value);
  __cloud.v3.puts.push({ pluginId, rel, digest });
  return { rel, path: rel, digest, bytes: String(value).length, uploaded: true };
}

export async function cloudV3FileGet(pluginId, rel, digest, inlineText) {
  let value = inlineText;
  if (value === undefined) {
    if (!__cloud.v3.objects.has(digest)) throw new Error(`CLOUD_NOT_FOUND: ${digest}`);
    value = __cloud.v3.objects.get(digest);
  }
  __cloud.v3.gets.push({ pluginId, rel, digest });
  __cloud.v3.applied.push({ pluginId, rel, value });
  const p = (__cloud.v3.local.plugins[pluginId] ??= { files: {}, blobs: {}, state: {} });
  p.files[rel] = value;
  return { path: `/fake/${pluginId}/${rel}`, bytes: String(value).length, virtual: rel.includes("/items/") };
}

export async function cloudV3FileDelete(pluginId, rel) {
  const p = __cloud.v3.local.plugins[pluginId];
  const had = !!p?.files?.[rel] || !!p?.blobs?.[rel];
  if (p?.files) delete p.files[rel];
  if (p?.blobs) delete p.blobs[rel];
  __cloud.v3.deleted.push({ pluginId, rel, had });
  return { removed: had, virtual: rel.includes("/items/") };
}

export async function cloudV3BlobPut(pluginId, rel) {
  const value = __cloud.v3.local.plugins[pluginId]?.blobs?.[rel];
  if (value === undefined) throw new Error(`blob 不存在: ${pluginId}/${rel}`);
  const digest = v3Digest(value);
  __cloud.v3.objects.set(digest, value);
  __cloud.v3.puts.push({ pluginId, rel, digest, blob: true });
  return { rel, path: rel, digest, bytes: String(value).length, uploaded: true };
}

export async function cloudV3BlobGet(pluginId, rel, digest) {
  if (!__cloud.v3.objects.has(digest)) throw new Error(`CLOUD_NOT_FOUND: ${digest}`);
  const value = __cloud.v3.objects.get(digest);
  __cloud.v3.gets.push({ pluginId, rel, digest, blob: true });
  __cloud.v3.applied.push({ pluginId, rel, value, blob: true });
  const p = (__cloud.v3.local.plugins[pluginId] ??= { files: {}, blobs: {}, state: {} });
  p.blobs[rel] = value;
  return { path: `/fake/${pluginId}/${rel}`, bytes: String(value).length, digest };
}
