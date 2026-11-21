/**
 * 市场索引签名与验签（ed25519）。
 *
 * ## 信任链
 *
 * ```
 * 客户端（内置公钥）
 *   └─ 验 index.dist.json 的 integrity.signature ──→ 才相信目录里的 sha256
 *        └─ 下载 .mspp 后校验 sha256（原有链路，防止字节被替换）
 * ```
 *
 * sha256 只能证明"包没被改"，证明不了"这份目录是市场发布的"。目录被篡改时，
 * 攻击者可以同时改 sha256 + 下载地址。因此目录本身必须由平台私钥签名，
 * 公钥编译在客户端里，**验签失败 → 整份目录拒绝**（fail-closed），不做降级。
 *
 * ## 签名对象
 *
 * `catalogSigningPayload()`：除 `integrity` 外的整个目录对象，键名递归排序后再
 * JSON.stringify。这样发布端的美化格式/字段顺序变化不会影响验签，而任何字段
 * （包括每条的 sha256、downloadUrl）被改都会导致签名不匹配。
 *
 * ## 密钥
 *
 * - 私钥：离线 / CI secret（`MARKET_INDEX_PRIVATE_KEY`），**不在仓库里**；
 * - 公钥：`MARKET_INDEX_PUBLIC_KEYS`，支持多把（轮换期间新旧并存）；
 * - 签名算法固定 ed25519，签名为 64 字节 hex；`keyId` 用于选公钥。
 *
 * 本模块不依赖 Node，前后端/浏览器通用（WebCrypto Ed25519）。
 */

/** 内置的市场索引公钥（轮换时保留旧 key 直到旧索引下线） */
export const MARKET_INDEX_PUBLIC_KEYS: readonly IndexPublicKey[] = [
  {
    keyId: "market-2026-01",
    publicKey: "d79c845b810f39d56af52f7fdb9328269cf28e1d41926ee7f9fd33df082567c3",
  },
];

export interface IndexPublicKey {
  keyId: string;
  /** 32 字节 ed25519 公钥，hex（小写） */
  publicKey: string;
}

export interface CatalogIntegrity {
  algorithm: "ed25519";
  keyId: string;
  /** 64 字节签名，hex（小写） */
  signature: string;
  signedAt: string;
}

export type CatalogReadResult =
  | { ok: true; catalog: import("./market-types.ts").MarketCatalog; signed: boolean }
  | { ok: false; errors: string[] };

/** ed25519 公钥 / 签名 hex 的形态 */
const PUBKEY_HEX = /^[0-9a-f]{64}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;

/**
 * 目录签名载荷：`{...doc}` 去掉 `integrity`，键递归排序后序列化。
 * 发布端与客户端必须使用同一函数（唯一事实来源）。
 */
export function catalogSigningPayload(doc: unknown): string {
  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) return "";
  const { integrity: _ignored, ...rest } = doc as Record<string, unknown>;
  return stableStringify(rest);
}

/** 递归按键名排序的 JSON.stringify（数组保持原顺序，undefined 按 JSON 规则省略） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 结构校验（不验签）：`parseCatalog` 与验签入口共用 */
export function isCatalogIntegrity(v: unknown): v is CatalogIntegrity {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    o.algorithm === "ed25519" &&
    typeof o.keyId === "string" &&
    o.keyId.length > 0 &&
    o.keyId.length <= 32 &&
    typeof o.signature === "string" &&
    SIG_HEX.test(o.signature) &&
    typeof o.signedAt === "string" &&
    o.signedAt.length > 0
  );
}

/**
 * 验签并解析市场目录。
 *
 * @param raw 原始文本或字节；**签名针对原始 JSON 对象**，不是 parse 后的规整对象
 * @param options.requireSignature 默认 true（官方市场链路）；本地测试可传 false
 * @param options.keys 公钥列表，默认内置平台公钥；测试可注入临时密钥
 */
export async function readCatalogWithIntegrity(
  raw: string | Uint8Array,
  options: { requireSignature?: boolean; keys?: readonly IndexPublicKey[] } = {}
): Promise<CatalogReadResult> {
  const { parseCatalog } = await import("./market-types.ts");
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8").decode(raw);

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, errors: ["catalog.invalid"] };
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, errors: ["json.invalid"] };
  }

  const requireSignature = options.requireSignature !== false;
  const keys = options.keys ?? MARKET_INDEX_PUBLIC_KEYS;
  const integrity = obj.integrity;

  if (integrity === undefined) {
    if (requireSignature) return { ok: false, errors: ["catalog.signature.missing"] };
    const parsed = parseCatalog(obj);
    return parsed.ok ? { ok: true, catalog: parsed.catalog, signed: false } : parsed;
  }

  if (!isCatalogIntegrity(integrity)) {
    return { ok: false, errors: ["catalog.signature.invalid"] };
  }

  const key = keys.find((k) => k.keyId === integrity.keyId);
  if (!key || !PUBKEY_HEX.test(key.publicKey)) {
    return { ok: false, errors: [`catalog.signature.unknownKey:${integrity.keyId}`] };
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { ok: false, errors: ["catalog.signature.noWebCrypto"] };

  let valid = false;
  try {
    const cryptoKey = await subtle.importKey(
      "raw",
      hexToBytes(key.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const payload = new TextEncoder().encode(catalogSigningPayload(obj));
    valid = await subtle.verify("Ed25519", cryptoKey, hexToBytes(integrity.signature), payload);
  } catch {
    return { ok: false, errors: ["catalog.signature.unsupported"] };
  }

  if (!valid) return { ok: false, errors: ["catalog.signature.badSignature"] };

  const parsed = parseCatalog(obj);
  return parsed.ok ? { ok: true, catalog: parsed.catalog, signed: true } : parsed;
}

/** 验签错误的中文文案（日志 / UI 用；不泄露密钥细节） */
export function describeCatalogSignatureError(errors: readonly string[]): string[] {
  return errors.map((code) => {
    if (code === "catalog.signature.missing") return "市场目录未签名，已拒绝（客户端只信任平台签名的目录）";
    if (code === "catalog.signature.invalid") return "市场目录签名结构不合法";
    if (code.startsWith("catalog.signature.unknownKey:")) {
      return `市场目录使用了未知签名密钥（${code.slice("catalog.signature.unknownKey:".length)}），可能客户端过旧或密钥已轮换`;
    }
    if (code === "catalog.signature.badSignature") return "市场目录验签失败，内容可能被篡改";
    if (code === "catalog.signature.noWebCrypto") return "当前环境缺少 WebCrypto，无法验签";
    if (code === "catalog.signature.unsupported") return "当前环境不支持 ed25519 验签";
    if (code === "json.invalid") return "市场目录不是合法 JSON";
    if (code === "catalog.invalid") return "市场目录结构不合法";
    return code;
  });
}
