/**
 * 插件包（`.msplugin` = ZIP）的读写 —— 纯浏览器 API，无第三方依赖。
 *
 * 为什么自己实现：插件安装包必须是普通 ZIP（这样用户和工具链都能直接打开、
 * 审查、重打包），但项目刻意不引入 zip 库；Node 22 与 WebView2（Chromium）
 * 都提供 `DecompressionStream` / `CompressionStream`，配合手写的
 * ZIP 结构解析即可覆盖 store / deflate 两种压缩方式与 zip64 基础字段。
 *
 * 安全：解析阶段就拒绝**绝对路径 / .. / 反斜杠穿越 / 符号链接标记**，
 * 把 zip-slip 挡在解包之前（Rust 侧落盘时还会再校验一次，双保险）。
 */

/** 记录数上限：正常插件远小于此，超出即视为异常包 */
const MAX_ENTRIES = 4096;
/** 单文件解压上限（64MB） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 解压总上限（256MB） */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 中央目录条目固定部分长度 */
const CENTRAL_HEADER_LEN = 46;
/** 本地文件头固定部分长度 */
const LOCAL_HEADER_LEN = 30;
/**
 * EOCD 固定部分长度（不含注释）。
 * 布局：+0 签名(4) / +4 本盘号(2) / +6 中央目录起始盘(2) / +8 本盘条目数(2)
 *      / +10 总条目数(2) / +12 中央目录大小(4) / +16 中央目录偏移(4) / +20 注释长度(2)
 * 注意 +20 是**注释长度**（2 字节），中央目录大小在 +12——两者相差 8 字节，
 * 读错会让「无注释的包」在 eocd+24 越界（历史 bug：安装时报
 * "Offset is outside the bounds of the DataView"）。
 */
const EOCD_LEN = 22;

/**
 * Uint8Array → base64（分块编码，避免 String.fromCharCode(...大数组) 爆栈。
 * btoa 期望 Latin-1 字符串，逐块转换保证任意大小的文件都安全）。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → Uint8Array（分块解码，配合读取大安装包使用） */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  // btoa 编码时按 0x8000 分块，这里反向按等大块解码，规避 atob 大字符串性能问题
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 一个解出来的文件 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 读取结果 */
export interface ReadZipResult {
  entries: ZipEntry[];
  /** 归一化后的路径集合（正斜杠、无前导 ./） */
  names: string[];
}

export interface ZipLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

/** 解包失败的原因（给用户看的可读文案） */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** 路径安全校验：拒绝绝对路径、上跳、盘符、协议、空字节 */
export function isSafeZipPath(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return false;
  if (raw.includes("\0")) return false;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.includes("://")) return false;
  return !normalized.split("/").some((seg) => seg === "..");
}

/** 归一化 zip 内路径（去掉 "./" 前缀与目录结尾斜杠） */
export function normalizeZipPath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * 读取 ZIP 的全部文件内容。
 *
 * 支持：store(0) / deflate(8)、UTF-8 文件名（bit 11）、zip64 的尺寸与偏移扩展字段。
 * 不支持：加密包（拒绝）、分卷包（拒绝）。
 */
export async function readZip(buffer: ArrayBuffer, limits: ZipLimits = {}): Promise<ReadZipResult> {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;

  const bytes = new Uint8Array(buffer as any);
  const view = new DataView(buffer);

  if (bytes.length < EOCD_LEN) throw new ZipError("不是有效的 ZIP 文件（文件过小）");

  const eocd = findEocd(view);
  if (eocd < 0) throw new ZipError("不是有效的 ZIP 文件（未找到中央目录）");

  // 注释长度（+20）用于确认 EOCD 之后的注释区确实在文件内（截断包会在这里被拦下）
  const commentLen = view.getUint16(eocd + 20, true);
  if (eocd + EOCD_LEN + commentLen > bytes.length) {
    throw new ZipError("ZIP 结束记录越界（文件可能不完整）");
  }

  // EOCD 字段偏移（务必对齐规范，+20 是注释长度而不是目录尺寸）：
  //   +10 总条目数 / +12 中央目录大小 / +16 中央目录偏移
  let totalEntries = view.getUint16(eocd + 10, true);
  let centralSize = view.getUint32(eocd + 12, true);
  let centralOffset = view.getUint32(eocd + 16, true);

  // zip64：EOCD 字段被写成 0xFFFF/0xFFFFFFFF 时，真实值在 zip64 EOCD 里
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    const locator = findZip64Locator(view, eocd);
    if (locator < 0) throw new ZipError("ZIP64 包缺少定位记录");
    const z64 = Number(view.getBigUint64(locator + 8, true));
    if (z64 < 0 || z64 + 56 > bytes.length) throw new ZipError("ZIP64 中央目录越界");
    if (view.getUint32(z64, true) !== SIG_EOCD64) throw new ZipError("ZIP64 中央目录标记错误");
    totalEntries = Number(view.getBigUint64(z64 + 32, true));
    centralSize = Number(view.getBigUint64(z64 + 40, true));
    centralOffset = Number(view.getBigUint64(z64 + 48, true));
  }

  if (!Number.isSafeInteger(totalEntries) || totalEntries < 0) throw new ZipError("ZIP 条目数异常");
  if (totalEntries === 0) throw new ZipError("ZIP 包内没有文件");
  if (totalEntries > maxEntries) {
    throw new ZipError(`插件包文件数过多（${totalEntries} > ${maxEntries}）`);
  }
  if (centralOffset + centralSize > bytes.length) throw new ZipError("中央目录越界");

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let ptr = centralOffset;
  let total = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (ptr + CENTRAL_HEADER_LEN > bytes.length || view.getUint32(ptr, true) !== SIG_CENTRAL) {
      throw new ZipError("中央目录条目损坏");
    }
    const flags = view.getUint16(ptr + 8, true);
    const method = view.getUint16(ptr + 10, true);
    let compressedSize = view.getUint32(ptr + 20, true);
    let uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentEntryLen = view.getUint16(ptr + 32, true);
    const externalAttrs = view.getUint32(ptr + 38, true);
    let localOffset = view.getUint32(ptr + 42, true);

    const entryEnd = ptr + CENTRAL_HEADER_LEN + nameLen + extraLen + commentEntryLen;
    if (entryEnd > bytes.length) throw new ZipError("中央目录条目越界（文件可能不完整）");

    const nameBytes = bytes.subarray(ptr + CENTRAL_HEADER_LEN, ptr + CENTRAL_HEADER_LEN + nameLen);
    const name = decoder.decode(nameBytes);

    // zip64 扩展字段：按顺序补 未压缩大小 -> 压缩大小 -> 本地偏移
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let ep = ptr + CENTRAL_HEADER_LEN + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = view.getUint16(ep, true);
        const size = view.getUint16(ep + 2, true);
        if (id === 0x0001) {
          let fp = ep + 4;
          const fieldEnd = Math.min(fp + size, bytes.length);
          if (uncompressedSize === 0xffffffff && fp + 8 <= fieldEnd) {
            uncompressedSize = Number(view.getBigUint64(fp, true));
            fp += 8;
          }
          if (compressedSize === 0xffffffff && fp + 8 <= fieldEnd) {
            compressedSize = Number(view.getBigUint64(fp, true));
            fp += 8;
          }
          if (localOffset === 0xffffffff && fp + 8 <= fieldEnd) {
            localOffset = Number(view.getBigUint64(fp, true));
          }
          break;
        }
        ep += 4 + size;
      }
      if (localOffset === 0xffffffff) throw new ZipError(`ZIP64 扩展字段缺失: ${name}`);
    }

    ptr = entryEnd;

    // 目录条目（以 / 结尾）跳过，但名字仍要走安全校验
    const isDir = name.endsWith("/") || name.endsWith("\\");
    if (isDir) continue;

    if ((flags & 0x1) !== 0) throw new ZipError("插件包已加密，无法安装");
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的压缩方式: ${method}`);

    if (!isSafeZipPath(name)) throw new ZipError(`插件包含不安全路径: ${name}`);
    const norm = normalizeZipPath(name);
    if (norm.length === 0) continue;
    if (seen.has(norm)) throw new ZipError(`插件包存在重复文件: ${norm}`);
    seen.add(norm);

    // 符号链接（unix 模式高 16 位 = 0xA000）直接拒绝
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) throw new ZipError(`插件包含符号链接: ${norm}`);

    if (uncompressedSize > maxEntryBytes) {
      throw new ZipError(`插件内文件过大: ${norm}（${uncompressedSize} 字节）`);
    }

    if (
      localOffset + LOCAL_HEADER_LEN > bytes.length ||
      view.getUint32(localOffset, true) !== SIG_LOCAL
    ) {
      throw new ZipError(`本地文件头损坏: ${norm}`);
    }
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + LOCAL_HEADER_LEN + lNameLen + lExtraLen;
    if (dataStart > bytes.length || dataStart + compressedSize > bytes.length) {
      throw new ZipError(`文件数据越界: ${norm}`);
    }
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw.slice();
      // store 方式下压缩大小即真实大小，尺寸不符说明包损坏
      if (compressedSize !== uncompressedSize) throw new ZipError(`文件尺寸不一致: ${norm}`);
    } else {
      data = await inflateRaw(raw);
      if (uncompressedSize !== 0xffffffff && data.length !== uncompressedSize) {
        // 尺寸不符说明包损坏（解压炸弹也会在这里被拦下）
        throw new ZipError(`文件解压结果异常: ${norm}`);
      }
    }
    total += data.length;
    if (total > maxTotalBytes) throw new ZipError("插件包解压后体积过大，已中止");
    entries.push({ name: norm, data });
  }

  return { entries, names: entries.map((e) => e.name) };
}

/**
 * 去掉 ZIP 内「单层包裹目录」。
 *
 * 用户把插件文件夹右键压缩时，包内路径会是 `baidu-translate/plugin.json`
 * 而不是规范的 `plugin.json`。只要**所有**条目都在同一个顶层目录下，
 * 就认为这层是打包时包进去的外壳（而不是插件自带的子目录），逐层剥掉，
 * 直到出现顶层文件或只剩一个共同前缀为止。
 */
export function stripWrappingDirectory(entries: readonly ZipEntry[]): ZipEntry[] {
  let current = entries.map((e) => ({ name: e.name, data: e.data }));
  // 最多剥 3 层，避免畸形包造成长循环
  for (let depth = 0; depth < 3; depth++) {
    if (current.length === 0) break;
    let root: string | null = null;
    let ok = true;
    for (const e of current) {
      const idx = e.name.indexOf("/");
      if (idx <= 0) {
        // 顶层文件（或非法名字）→ 不再具备「唯一包裹目录」特征
        ok = false;
        break;
      }
      const seg = e.name.slice(0, idx);
      if (root == null) root = seg;
      else if (root !== seg) {
        ok = false;
        break;
      }
    }
    if (!ok || root == null) break;
    current = current.map((e) => ({ name: e.name.slice(root.length + 1), data: e.data }));
  }
  return current;
}

/**
 * 从尾部向前查找 EOCD 签名。
 *
 * 注释区最长 0xFFFF，因此 EOCD 起点最多出现在 `len-22-0xFFFF` 处。
 * 找不到时返回 -1（由调用方给出可读错误）。
 */
function findEocd(view: DataView): number {
  const minPos = Math.max(0, view.byteLength - EOCD_LEN - 0xffff);
  for (let i = view.byteLength - EOCD_LEN; i >= minPos; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/** 查找 zip64 EOCD 定位记录（紧邻 EOCD 之前的 20 字节） */
function findZip64Locator(view: DataView, eocd: number): number {
  const p = eocd - 20;
  if (p < 0 || p + 20 > view.byteLength) return -1;
  return view.getUint32(p, true) === SIG_EOCD64_LOCATOR ? p : -1;
}

/** raw deflate 解压（DecompressionStream） */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw" as unknown as CompressionFormat);
  const writer = ds.writable.getWriter();
  // 不要 await write：大文件下 writable 背压会等到 readable 被消费才 resolve
  void writer.write(data as unknown as any).then(() => writer.close().catch(() => undefined)).catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_ENTRY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ZipError("解压结果超过单文件上限");
    }
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** raw deflate 压缩（CompressionStream） */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw" as unknown as CompressionFormat);
  const writer = cs.writable.getWriter();
  const buf = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  void writer.write(buf).then(() => writer.close().catch(() => undefined)).catch(() => undefined);
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/* ============================================================
 * CRC32（写包时必需，读包时不校验以容忍工具链差异）
 * ============================================================ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** 计算 CRC32 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ============================================================
 * 写 ZIP（供工具链打包 .msplugin 用，Node 与浏览器通用）
 * ============================================================ */

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * 打包成 ZIP（deflate 压缩、UTF-8 文件名）。
 * 文件按名字升序写入，保证同样的输入产出同样的字节（便于比对哈希）。
 */
export async function writeZip(files: ZipEntry[], now: Date = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of sorted) {
    if (!isSafeZipPath(f.name)) throw new ZipError(`不安全的文件名: ${f.name}`);
    const nameBytes = encoder.encode(normalizeZipPath(f.name));
    const compressed = await deflateRaw(f.data);
    // 压缩后反而更大（已压缩内容）时退回 store
    const useStore = compressed.length >= f.data.length;
    const payload = useStore ? f.data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(f.data);

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 名称
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    // unix 权限：backend/ 下的可执行文件给 0755，其余 0644
    const isExec = /(^|\/)backend\//.test(f.name) && /\.(exe|sh|command|bin|py|js)$/i.test(f.name);
    cv.setUint32(38, (isExec ? 0o100755 : 0o100644) << 16, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, sorted.length, true);
  ev.setUint16(10, sorted.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}
