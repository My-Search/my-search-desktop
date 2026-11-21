//! 云同步 v2：**分片对象 + manifest 提交点**
//!
//! v1 的云端只有一个 `.msbackup` 整包：改一条待办要重传整包，新设备要下整包，
//! 「只同步某个插件」「看每个插件占多少云空间」都无从谈起。v2 把用户态拆成若干
//! **不可变对象**，云端只存对象，用一个 `manifest.json` 记录「当前生效的是哪几片」：
//!
//! ```text
//! <remote_file>.cloud/
//!   manifest.json                          ← 唯一原子提交点（最后写）
//!   core-<digest>.msbackup                 ← 内部状态 + 设置 + 非插件 localStorage
//!   plugins/<id>/body-<digest>.msbackup    ← 插件主体（安装文件 / 开发挂载源码 / sync-store）
//!   plugins/<id>/data-<digest>.msbackup    ← 插件数据（kv 等白名单）
//!   blobs/ab/<sha256>                      ← （后续）内容寻址大对象
//!   packs/<id>/<packId>.bin                ← （后续）小对象追加包
//! ```
//!
//! 为什么对象**按摘要命名**
//! ------------------------
//! - 同一份内容重复上传是幂等的（`If-None-Match: *` 已存在就跳过），不需要逐片
//!   维护 ETag，也不存在「两个设备同时写同一片、后者覆盖前者」的静默丢数据；
//! - 提交点只有 manifest 一处，写 manifest 失败 → 旧 manifest 仍指向旧对象，
//!   远端永远处于「某个完整状态」，不会出现半新半旧；
//! - 旧对象变成孤儿，由 GC 按 manifest 清理（带宽限期，误判也能救回）。
//!
//! 本模块只负责「对象层 + 分片打包/落地 + 摘要」，决策（谁该传、谁该下）在前端
//! `src/lib/sync/cloud-engine.ts`。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::cloud::{
    build_client, load_config, webdav_auth, webdav_url, RemoteMeta, SyncConfig,
};
use crate::credential_store::{load_credentials, Credentials};

/// 云端目录后缀（相对 `remote_file`）
const CLOUD_DIR_SUFFIX: &str = ".cloud";
/// v2 提交点对象名（迁移后 v3 只读）
const MANIFEST_REL: &str = "manifest.json";
/// v3 提交点对象名
const MANIFEST_V3_REL: &str = "manifest-v3.json";
/// 单插件云端配额（逻辑引用计）：200 MB
pub const PLUGIN_QUOTA_BYTES: u64 = 200 * 1024 * 1024;
/// 单片上限（防止误把整机数据当一片传）
const MAX_SHARD_BYTES: u64 = 200 * 1024 * 1024;
/// v3 manifest 上限（2 MB；超过说明内联阈值或对象数失控）
const MAX_MANIFEST_V3_BYTES: u64 = 2 * 1024 * 1024;
/// v3 单文件对象上限（64 MB）
const MAX_V3_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

// ===================== 路径 =====================

fn encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for ch in seg.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{:02X}", ch as u32));
        }
    }
    out
}

fn cloud_root(cfg: &SyncConfig) -> Result<String, String> {
    Ok(format!("{}{CLOUD_DIR_SUFFIX}", webdav_url(cfg)?))
}

fn object_url(cfg: &SyncConfig, rel: &str) -> Result<String, String> {
    let root = cloud_root(cfg)?;
    let mut url = root;
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        url.push('/');
        url.push_str(&encode_segment(seg));
    }
    Ok(url)
}

/// 对象相对路径白名单校验：前端可传 rel，但只能落在云端目录的既定分区里。
fn clean_rel(rel: &str) -> Result<String, String> {
    let t = rel.trim().trim_start_matches('/');
    if t.is_empty() || t.contains("..") || t.contains("://") || t.contains('\0') || t.contains('\\') {
        return Err(err("非法的云端对象路径"));
    }
    let ok = t == MANIFEST_REL
        || t == MANIFEST_V3_REL
        || t.starts_with("core-")
        || t.starts_with("blobs/")
        || t.starts_with("packs/")
        || t.starts_with("plugins/");
    if !ok || t.ends_with('/') {
        return Err(err(format!("不在允许的云端分区内: {t}")));
    }
    Ok(t.to_string())
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !id.starts_with('.')
}

// ===================== HTTP 对象层 =====================

async fn mkcol(client: &reqwest::Client, cfg: &SyncConfig, creds: &Credentials, url: &str) -> Result<(), String> {
    let resp = webdav_auth(
        client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), url),
        cfg,
        creds,
    )
    .send()
    .await
    .map_err(|e| err(format!("连接 WebDAV 失败: {e}")))?;
    let code = resp.status().as_u16();
    if !(200..300).contains(&code) && !matches!(code, 301 | 403 | 405) {
        return Err(err(format!("创建远端目录失败: HTTP {code}")));
    }
    Ok(())
}

/// 逐级创建 `rel` 的父目录（含云端根）
async fn ensure_dirs(client: &reqwest::Client, cfg: &SyncConfig, creds: &Credentials, rel: &str) -> Result<(), String> {
    let root = cloud_root(cfg)?;
    mkcol(client, cfg, creds, &format!("{root}/")).await?;
    let mut url = root;
    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    for seg in segments.iter().take(segments.len().saturating_sub(1)) {
        url.push('/');
        url.push_str(&encode_segment(seg));
        mkcol(client, cfg, creds, &format!("{url}/")).await?;
    }
    Ok(())
}

async fn obj_meta(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    creds: &Credentials,
    rel: &str,
) -> Result<RemoteMeta, String> {
    let url = object_url(cfg, rel)?;
    let resp = webdav_auth(client.head(&url), cfg, creds)
        .send()
        .await
        .map_err(|e| err(format!("连接 WebDAV 失败: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(RemoteMeta::default());
    }
    if !status.is_success() {
        return Err(err(format!("WebDAV 返回 HTTP {}", status.as_u16())));
    }
    let headers = resp.headers();
    let etag = headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let modified = headers
        .get("last-modified")
        .and_then(|v| v.to_str().ok())
        .map(crate::cloud::parse_http_date_public)
        .unwrap_or(0);
    let size = headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let rev = if etag.is_empty() {
        format!("{size}-{modified}")
    } else {
        etag.trim_matches('"').to_string()
    };
    Ok(RemoteMeta { exists: true, rev, etag, modified, size })
}

async fn obj_get(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    creds: &Credentials,
    rel: &str,
) -> Result<(Vec<u8>, RemoteMeta), String> {
    let url = object_url(cfg, rel)?;
    let resp = webdav_auth(client.get(&url), cfg, creds)
        .send()
        .await
        .map_err(|e| err(format!("下载失败: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err(err(format!("CLOUD_NOT_FOUND: 云端对象不存在 {rel}")));
    }
    if !status.is_success() {
        return Err(err(format!("下载失败: HTTP {}", status.as_u16())));
    }
    let headers = resp.headers().clone();
    let etag = headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| err(format!("读取响应失败: {e}")))?
        .to_vec();
    let size = bytes.len() as u64;
    let rev = if etag.is_empty() {
        format!("{size}-{}", now_ms())
    } else {
        etag.trim_matches('"').to_string()
    };
    Ok((
        bytes,
        RemoteMeta { exists: true, rev, etag, modified: now_ms(), size },
    ))
}

/// `if_match`：`Some("")` = 仅当不存在时创建；`Some(etag)` = 条件覆盖；`None` = 无条件
async fn obj_put(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    creds: &Credentials,
    rel: &str,
    bytes: Vec<u8>,
    if_match: Option<String>,
) -> Result<RemoteMeta, String> {
    ensure_dirs(client, cfg, creds, rel).await?;
    let url = object_url(cfg, rel)?;
    let size = bytes.len() as u64;
    let mut req = webdav_auth(
        client
            .put(&url)
            .header("Content-Type", "application/octet-stream")
            .body(bytes),
        cfg,
        creds,
    );
    if let Some(expected) = if_match {
        if expected.is_empty() {
            req = req.header("If-None-Match", "*");
        } else {
            req = req.header("If-Match", expected);
        }
    }
    let resp = req.send().await.map_err(|e| err(format!("上传失败: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 412 {
        // 412 有两种含义，必须分开：
        //  · 内容寻址的分片（If-None-Match: *）→ 另一台设备刚好传了**同内容**，视为已上传；
        //  · manifest（If-Match / If-None-Match）→ 别的设备在这几秒内提交过，必须冲突重试，
        //    绝不能当成「已存在」吞掉，否则本机改动会静默丢失。
        if rel == MANIFEST_REL || rel == MANIFEST_V3_REL {
            return Err(err("SYNC_CONFLICT: 远端 manifest 已被其他设备修改"));
        }
        return Err(err("CLOUD_EXISTS: 对象已存在（同内容无需重传）"));
    }
    if status.as_u16() == 507 {
        return Err(err("CLOUD_FULL: 云端空间不足（WebDAV 返回 507）"));
    }
    if !status.is_success() {
        return Err(err(format!("上传失败: HTTP {}", status.as_u16())));
    }
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(RemoteMeta {
        exists: true,
        rev: etag.trim_matches('"').to_string(),
        etag,
        modified: now_ms(),
        size,
    })
}

async fn obj_delete(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    creds: &Credentials,
    rel: &str,
) -> Result<bool, String> {
    let url = object_url(cfg, rel)?;
    let resp = webdav_auth(client.delete(&url), cfg, creds)
        .send()
        .await
        .map_err(|e| err(format!("删除失败: {e}")))?;
    let code = resp.status().as_u16();
    if code == 404 {
        return Ok(false);
    }
    if !resp.status().is_success() {
        return Err(err(format!("删除失败: HTTP {code}")));
    }
    Ok(true)
}

// ===================== 分片构建 =====================

fn files_for_scope(app: &AppHandle, scope: &str) -> Result<Vec<(String, PathBuf)>, String> {
    if scope == "core" {
        return crate::backup::collect_core_files(app);
    }
    if let Some(id) = scope.strip_prefix("body:") {
        if !is_safe_id(id) {
            return Err(err("非法插件 id"));
        }
        return crate::backup::collect_plugin_body_files(app, id);
    }
    if let Some(id) = scope.strip_prefix("data:") {
        if !is_safe_id(id) {
            return Err(err("非法插件 id"));
        }
        return crate::backup::collect_plugin_data_files(app, id);
    }
    Err(err(format!("未知分片: {scope}")))
}

fn shard_rel(scope: &str, digest: &str) -> Result<String, String> {
    if scope == "core" {
        return Ok(format!("core-{digest}.msbackup"));
    }
    if let Some(id) = scope.strip_prefix("body:") {
        return Ok(format!("plugins/{id}/body-{digest}.msbackup"));
    }
    if let Some(id) = scope.strip_prefix("data:") {
        return Ok(format!("plugins/{id}/data-{digest}.msbackup"));
    }
    Err(err(format!("未知分片: {scope}")))
}

fn scope_label(scope: &str) -> String {
    if scope == "core" {
        return "core".into();
    }
    let id = scope
        .strip_prefix("body:")
        .or_else(|| scope.strip_prefix("data:"))
        .unwrap_or(scope);
    id.to_string()
}

/// 计算分片摘要与体积（不打包，不联网）
fn digest_scope(
    app: &AppHandle,
    scope: &str,
    ls: &Value,
    settings: Option<&Value>,
) -> Result<(String, u64, usize), String> {
    let files = files_for_scope(app, scope)?;
    let count = files.len();
    let use_ls = if ls.is_object() { Some(ls) } else { None };
    let (digest, bytes) = crate::backup::shard_digest(&files, use_ls, settings)?;
    Ok((digest, bytes, count))
}

// ===================== v3：每文件对象 + 内联 + blob =====================

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn file_digest(path: &Path) -> Result<(String, u64, Vec<u8>), String> {
    let bytes = std::fs::read(path)
        .map_err(|e| err(format!("读取文件失败 {}: {e}", path.display())))?;
    Ok((sha256_hex(&bytes), bytes.len() as u64, bytes))
}

/// 对象名里的路径哈希：只取前 16 位，避免 WebDAV 路径过长。
fn v3_file_rel(plugin_id: &str, rel: &str, digest: &str) -> Result<String, String> {
    if !is_safe_id(plugin_id) {
        return Err(err("非法插件 id"));
    }
    if !crate::plugin_host::is_safe_relative(rel) {
        return Err(err(format!("非法文件路径: {rel}")));
    }
    let path_hash: String = sha256_hex(rel.as_bytes()).chars().take(16).collect();
    Ok(format!("plugins/{plugin_id}/files/{path_hash}-{digest}.msf"))
}

fn blob_rel(digest: &str) -> Result<String, String> {
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(err("非法 blob 摘要"));
    }
    Ok(format!("blobs/{}/{}", &digest[..2], digest))
}

fn plugin_data_path(app: &AppHandle, plugin_id: &str, rel: &str) -> Result<PathBuf, String> {
    if !is_safe_id(plugin_id) {
        return Err(err("非法插件 id"));
    }
    if !crate::plugin_host::is_safe_relative(rel) {
        return Err(err(format!("非法插件数据路径: {rel}")));
    }
    Ok(crate::plugin_host::plugin_data_dir(app, plugin_id)?.join(rel))
}

fn plugin_rel_of(full_rel: &str, plugin_id: &str) -> Option<String> {
    full_rel
        .strip_prefix(&format!("plugin-data/{plugin_id}/"))
        .map(|s| s.trim_start_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// 内联只接受 ≤2KB 的 UTF-8 文本；二进制 / 大文件一律落对象。
fn inline_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() > 2048 {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    if text.as_bytes().contains(&0) {
        return None;
    }
    Some(text.to_string())
}

fn v3_entry(path: &str, digest: &str, bytes: u64, inline: Option<String>) -> Value {
    let mut obj = Map::new();
    obj.insert("path".into(), json!(path));
    obj.insert("digest".into(), json!(digest));
    obj.insert("bytes".into(), json!(bytes));
    if let Some(text) = inline {
        obj.insert("inline".into(), json!(text));
    }
    Value::Object(obj)
}

#[derive(Clone, Debug)]
struct ItemizedSpec {
    source: String,
    dir: String,
    items_key: String,
    id_field: String,
    /// 可选字段级过滤：只有条目同时满足所有 key/value 才参与同步。
    /// 剪贴板用 `{ "retained": true }` 只同步收藏/分类条目，普通历史留本机。
    filter: Option<Value>,
    /// 条目里哪些字段是 blob 相对路径（如剪贴板的 `relPath`）。
    /// 有过滤时，blob 只同步这些被选中条目引用到的文件。
    blob_fields: Vec<String>,
}

fn itemized_specs(app: &AppHandle, plugin_id: &str) -> Vec<ItemizedSpec> {
    let policy = crate::backup::plugin_backup_policy(app, plugin_id);
    itemized_specs_from(&policy)
}

fn itemized_specs_from(policy: &Value) -> Vec<ItemizedSpec> {
    let Some(list) = policy.get("itemized").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            let source = item.get("file").or_else(|| item.get("source"))?.as_str()?.trim();
            let dir = item.get("dir")?.as_str()?.trim();
            if !crate::plugin_host::is_safe_relative(source)
                || !crate::plugin_host::is_safe_relative(dir)
            {
                return None;
            }
            let items_key = item
                .get("itemsKey")
                .and_then(|v| v.as_str())
                .unwrap_or("items")
                .to_string();
            let id_field = item
                .get("idField")
                .and_then(|v| v.as_str())
                .unwrap_or("id")
                .to_string();
            let filter = item.get("filter").filter(|v| v.is_object()).cloned();
            let blob_fields = item
                .get("blobFields")
                .and_then(|v| v.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Some(ItemizedSpec {
                source: source.trim_matches('/').to_string(),
                dir: dir.trim_matches('/').to_string(),
                items_key,
                id_field,
                filter,
                blob_fields,
            })
        })
        .collect()
}

fn item_id_of(item: &Value, field: &str) -> Option<String> {
    let id = item.get(field)?.as_str()?.trim();
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(id.to_string())
}

fn itemized_virtual<'a>(
    specs: &'a [ItemizedSpec],
    rel: &str,
) -> Option<(&'a ItemizedSpec, String)> {
    for spec in specs {
        let prefix = format!("{}/", spec.dir);
        if let Some(name) = rel.strip_prefix(&prefix) {
            if name.contains('/') || !name.ends_with(".json") {
                continue;
            }
            let id = name.trim_end_matches(".json");
            if !id.is_empty() && crate::plugin_host::is_safe_relative(name) {
                return Some((spec, id.to_string()));
            }
        }
    }
    None
}

fn load_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

fn save_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("创建目录失败: {e}")))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(value).map_err(|e| err(format!("序列化失败: {e}")))?;
    std::fs::write(&tmp, text).map_err(|e| err(format!("写入失败: {e}")))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Windows 目标存在时 rename 可能失败：退回直接覆盖（内容已完整序列化）
        std::fs::write(path, serde_json::to_string(value).unwrap_or_default())
            .map_err(|_| err(format!("替换失败: {e}")))?;
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

fn upsert_item(
    path: &Path,
    items_key: &str,
    id_field: &str,
    item: Value,
) -> Result<(), String> {
    let id = item_id_of(&item, id_field).ok_or_else(|| err("条目缺少合法 id"))?;
    let mut root = load_json(path);
    if !root.is_object() {
        root = json!({});
    }
    let items = root
        .get(items_key)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut list = items;
    let pos = list
        .iter()
        .position(|v| item_id_of(v, id_field).as_deref() == Some(id.as_str()));
    if let Some(i) = pos {
        list[i] = item;
    } else {
        list.push(item);
    }
    // 剪贴板索引按 createdAt 倒序；未知时间字段的条目保持插入顺序
    list.sort_by(|a, b| {
        let ta = a.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    if let Some(obj) = root.as_object_mut() {
        obj.insert(items_key.to_string(), Value::Array(list));
    }
    save_json(path, &root)
}

fn remove_item(path: &Path, items_key: &str, id_field: &str, id: &str) -> Result<bool, String> {
    let mut root = load_json(path);
    let Some(items) = root.get(items_key).and_then(|v| v.as_array()) else {
        return Ok(false);
    };
    let before = items.len();
    let kept: Vec<Value> = items
        .iter()
        .filter(|v| item_id_of(v, id_field).as_deref() != Some(id))
        .cloned()
        .collect();
    if kept.len() == before {
        return Ok(false);
    }
    if let Some(obj) = root.as_object_mut() {
        obj.insert(items_key.to_string(), Value::Array(kept));
    }
    save_json(path, &root)?;
    Ok(true)
}

fn notify_plugin_data(app: &AppHandle, plugin_id: &str, key: &str) {
    let _ = app.emit(
        crate::plugin_host::EVENT_PLUGIN_DATA_CHANGED,
        json!({ "pluginId": plugin_id, "key": key, "removed": false }),
    );
}

fn item_matches_filter(item: &Value, filter: &Option<Value>) -> bool {
    let Some(Value::Object(want)) = filter else {
        return true;
    };
    want.iter()
        .all(|(key, expected)| item.get(key) == Some(expected))
}

fn itemized_entries_from_root(root: &Value, spec: &ItemizedSpec) -> Vec<Value> {
    let Some(items) = root.get(&spec.items_key).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        if !item_matches_filter(item, &spec.filter) {
            continue;
        }
        let Some(id) = item_id_of(item, &spec.id_field) else {
            continue;
        };
        let bytes = match serde_json::to_vec(item) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let rel = format!("{}/{}.json", spec.dir, id);
        let digest = sha256_hex(&bytes);
        out.push(v3_entry(
            &rel,
            &digest,
            bytes.len() as u64,
            inline_text(&bytes),
        ));
    }
    out
}

fn itemized_entries(app: &AppHandle, plugin_id: &str, specs: &[ItemizedSpec]) -> Vec<Value> {
    let mut out = Vec::new();
    for spec in specs {
        let Ok(path) = plugin_data_path(app, plugin_id, &spec.source) else {
            continue;
        };
        let root = load_json(&path);
        out.extend(itemized_entries_from_root(&root, spec));
    }
    out
}

/// 从一个 itemized 源 JSON 中收集被过滤选中条目引用的 blob 路径。
fn itemized_selected_blob_paths(root: &Value, spec: &ItemizedSpec) -> std::collections::HashSet<String> {
    let mut allowed = std::collections::HashSet::new();
    let Some(items) = root.get(&spec.items_key).and_then(|v| v.as_array()) else {
        return allowed;
    };
    for item in items {
        if !item_matches_filter(item, &spec.filter) {
            continue;
        }
        for field in &spec.blob_fields {
            let Some(rel) = item.get(field).and_then(|v| v.as_str()) else {
                continue;
            };
            let rel = rel.trim().trim_matches('/');
            if !rel.is_empty() && crate::plugin_host::is_safe_relative(rel) {
                allowed.insert(rel.to_string());
            }
        }
    }
    allowed
}

/// 被 itemized 过滤选中的条目所引用的 blob 路径集合。
/// 返回 `None` 表示没有配置过滤，blob 仍按 `backup.blobs` 前缀全收；
/// 返回 `Some(空集)` 表示有过滤但一条也没选中，不应上传任何 blob。
fn itemized_blob_paths(
    app: &AppHandle,
    plugin_id: &str,
    specs: &[ItemizedSpec],
) -> Option<std::collections::HashSet<String>> {
    let mut restricted = false;
    let mut allowed = std::collections::HashSet::new();
    for spec in specs {
        if spec.filter.is_none() || spec.blob_fields.is_empty() {
            continue;
        }
        restricted = true;
        let Ok(path) = plugin_data_path(app, plugin_id, &spec.source) else {
            continue;
        };
        let root = load_json(&path);
        allowed.extend(itemized_selected_blob_paths(&root, spec));
    }
    restricted.then_some(allowed)
}

fn scan_plugin_files(
    app: &AppHandle,
    plugin_id: &str,
    policy: &Value,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let specs = itemized_specs(app, plugin_id);
    let source_paths: Vec<String> = specs.iter().map(|s| s.source.clone()).collect();
    let mut files: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();

    for (full, path) in crate::backup::collect_plugin_data_files(app, plugin_id)? {
        let Some(rel) = plugin_rel_of(&full, plugin_id) else {
            continue;
        };
        if source_paths.iter().any(|s| s == &rel) {
            continue; // 由 itemized 拆成按条虚拟文件
        }
        let (digest, bytes, raw) = file_digest(&path)?;
        if bytes > MAX_V3_FILE_BYTES {
            continue;
        }
        files.insert(
            rel.clone(),
            v3_entry(&rel, &digest, bytes, inline_text(&raw)),
        );
    }
    for entry in itemized_entries(app, plugin_id, &specs) {
        if let Some(path) = entry.get("path").and_then(|v| v.as_str()) {
            files.insert(path.to_string(), entry);
        }
    }

    let allowed_blobs = itemized_blob_paths(app, plugin_id, &specs);
    let mut blobs = Vec::new();
    for (full, path) in crate::backup::collect_plugin_blob_files(app, plugin_id, allowed_blobs.as_ref())? {
        let Some(rel) = plugin_rel_of(&full, plugin_id) else {
            continue;
        };
        if files.contains_key(&rel) {
            continue;
        }
        let (digest, bytes, _) = file_digest(&path)?;
        if bytes > MAX_V3_FILE_BYTES {
            continue;
        }
        blobs.push(v3_entry(&rel, &digest, bytes, None));
    }
    let _ = policy; // 保留参数：未来按 policy 做更多裁剪
    Ok((
        files.into_values().collect(),
        blobs,
    ))
}

// ===================== 命令 =====================

fn cfg_pair(app: &AppHandle) -> (SyncConfig, Credentials) {
    (load_config(app), load_credentials(app))
}

/// 读云端 manifest（提交点）
#[tauri::command]
pub async fn cloud_manifest_get(app: AppHandle) -> Result<Value, String> {
    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        if cfg.webdav_url.trim().is_empty() {
            return Err(err("请先填写 WebDAV 地址"));
        }
        let client = build_client(60)?;
        match obj_get(&client, &cfg, &creds, MANIFEST_REL).await {
            Ok((bytes, meta)) => {
                let manifest: Value = serde_json::from_slice(&bytes)
                    .map_err(|e| err(format!("云端 manifest 解析失败: {e}")))?;
                Ok(json!({
                    "exists": true,
                    "etag": meta.etag,
                    "rev": meta.rev,
                    "size": meta.size,
                    "modified": meta.modified,
                    "manifest": manifest,
                }))
            }
            Err(e) if e.starts_with("CLOUD_NOT_FOUND") => Ok(json!({ "exists": false, "manifest": Value::Null })),
            Err(e) => Err(e),
        }
    })
    .await
}

/// 写云端 manifest（**最后一步**，等于提交）
#[tauri::command]
pub async fn cloud_manifest_put(
    app: AppHandle,
    manifest: Value,
    if_match: Option<String>,
) -> Result<Value, String> {
    if !manifest.is_object() {
        return Err(err("manifest 必须是对象"));
    }
    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(60)?;
        let bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|e| err(format!("序列化 manifest 失败: {e}")))?;
        // 服务器没给 ETag（前端传 null）时**不要**无条件写：先 HEAD 拿当前 ETag，
        // 再用它做 If-Match。竞态窗口仍在（HEAD 到 PUT 之间），但至少不会「盲写覆盖」。
        let guard = match if_match {
            Some(v) => Some(v),
            None => match obj_meta(&client, &cfg, &creds, MANIFEST_REL).await {
                Ok(m) if m.exists && !m.etag.is_empty() => Some(m.etag),
                _ => None,
            },
        };
        let meta = obj_put(&client, &cfg, &creds, MANIFEST_REL, bytes, guard).await?;
        Ok(json!({ "ok": true, "etag": meta.etag, "rev": meta.rev, "size": meta.size, "modified": meta.modified }))
    })
    .await
}

/// v3 本地快照：core/body 复用 v2 摘要，插件数据拆成「每文件 + 内联 + blob」。
///
/// 入参仍是前端切好的 localStorage 子集。Rust 只读盘、算摘要、按 `plugin.json`
/// 的 `backup.itemized` / `backup.blobs` 声明产出虚拟文件，不决定同步方向。
#[tauri::command]
pub fn cloud_v3_scan(app: AppHandle, local_storage: Value) -> Result<Value, String> {
    let core_ls = local_storage.get("core").cloned().unwrap_or(Value::Null);
    let plugin_ls = local_storage.get("plugins").cloned().unwrap_or(json!({}));
    let settings = crate::read_backup_settings(&app);
    let (core_digest, core_bytes, core_files) =
        digest_scope(&app, "core", &core_ls, Some(&settings))?;

    let mut plugins = Map::new();
    for id in crate::backup::syncable_plugin_ids(&app)? {
        let policy = crate::backup::plugin_backup_policy(&app, &id);
        let (body_digest, body_bytes, body_files) =
            digest_scope(&app, &format!("body:{id}"), &json!({}), None)?;
        let (files, blobs) = scan_plugin_files(&app, &id, &policy)?;
        let state = plugin_ls.get(&id).cloned().unwrap_or_else(|| json!({}));
        let has_state = state.as_object().map(|m| !m.is_empty()).unwrap_or(false);
        if body_files == 0 && files.is_empty() && blobs.is_empty() && !has_state {
            continue;
        }
        let body = if body_files == 0 {
            json!({ "digest": "", "bytes": 0, "files": 0 })
        } else {
            json!({ "digest": body_digest, "bytes": body_bytes, "files": body_files })
        };
        plugins.insert(
            id,
            json!({
                "body": body,
                "state": state,
                "files": files,
                "blobs": blobs,
            }),
        );
    }

    Ok(json!({
        "core": { "digest": core_digest, "bytes": core_bytes, "files": core_files },
        "plugins": plugins,
        "appVersion": app_version(&app),
        "at": now_ms(),
    }))
}

/// 上传一个 v3 文件对象。虚拟条目（`backup.itemized`）从源索引里取当前条目，
/// 常规文件直接读 `plugin-data/<id>/<rel>`；两者都按内容摘要命名，重复上传幂等。
#[tauri::command]
pub async fn cloud_v3_file_put(
    app: AppHandle,
    plugin_id: String,
    rel: String,
) -> Result<Value, String> {
    if !is_safe_id(&plugin_id) || !crate::plugin_host::is_safe_relative(&rel) {
        return Err(err("非法的插件文件路径"));
    }
    let specs = itemized_specs(&app, &plugin_id);
    let bytes = if let Some((spec, id)) = itemized_virtual(&specs, &rel) {
        let source = plugin_data_path(&app, &plugin_id, &spec.source)?;
        let root = load_json(&source);
        let item = root
            .get(&spec.items_key)
            .and_then(|v| v.as_array())
            .and_then(|items| {
                items
                    .iter()
                    .find(|v| item_id_of(v, &spec.id_field).as_deref() == Some(id.as_str()))
            })
            .cloned()
            .ok_or_else(|| err(format!("源索引里找不到条目 {id}")))?;
        serde_json::to_vec(&item).map_err(|e| err(format!("序列化条目失败: {e}")))?
    } else {
        let path = plugin_data_path(&app, &plugin_id, &rel)?;
        std::fs::read(&path).map_err(|e| err(format!("读取文件失败 {}: {e}", path.display())))?
    };
    if bytes.len() as u64 > MAX_V3_FILE_BYTES {
        return Err(err(format!(
            "CLOUD_QUOTA: 单文件过大（{} MB，上限 {} MB）",
            bytes.len() / 1024 / 1024,
            MAX_V3_FILE_BYTES / 1024 / 1024
        )));
    }
    let digest = sha256_hex(&bytes);
    let object_rel = v3_file_rel(&plugin_id, &rel, &digest)?;
    let size = bytes.len() as u64;

    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(120)?;
        let meta = obj_meta(&client, &cfg, &creds, &object_rel).await?;
        if meta.exists {
            return Ok(json!({
                "rel": object_rel, "path": rel, "digest": digest, "bytes": meta.size.max(size),
                "uploaded": false,
            }));
        }
        let _ = obj_put(&client, &cfg, &creds, &object_rel, bytes, Some(String::new())).await?;
        Ok(json!({
            "rel": object_rel, "path": rel, "digest": digest, "bytes": size, "uploaded": true,
        }))
    })
    .await
}

/// 下载一个 v3 文件对象并落地。`inline_text` 非空时直接写内联内容，不联网。
/// 虚拟条目会合并回源索引（而不是在磁盘上造一个插件并不读的 `items/` 文件）。
#[tauri::command]
pub async fn cloud_v3_file_get(
    app: AppHandle,
    plugin_id: String,
    rel: String,
    digest: String,
    inline_text: Option<String>,
) -> Result<Value, String> {
    if !is_safe_id(&plugin_id)
        || !crate::plugin_host::is_safe_relative(&rel)
        || digest.len() != 64
        || !digest.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(err("非法的文件下载参数"));
    }
    let specs = itemized_specs(&app, &plugin_id);
    let virtual_item = itemized_virtual(&specs, &rel);

    let bytes = if let Some(text) = inline_text {
        text.into_bytes()
    } else {
        let object_rel = v3_file_rel(&plugin_id, &rel, &digest)?;
        let rel_for_get = object_rel;
        let app_for_get = app.clone();
        crate::sync_service::with_sync_gate(async move {
            let (cfg, creds) = cfg_pair(&app_for_get);
            let client = build_client(120)?;
            let (bytes, _) = obj_get(&client, &cfg, &creds, &rel_for_get).await?;
            Ok::<Vec<u8>, String>(bytes)
        })
        .await?
    };
    if sha256_hex(&bytes) != digest {
        return Err(err("下载文件摘要不匹配，已拒绝写入"));
    }

    if let Some((spec, id)) = virtual_item {
        let source = plugin_data_path(&app, &plugin_id, &spec.source)?;
        let item: Value =
            serde_json::from_slice(&bytes).map_err(|e| err(format!("条目 JSON 损坏: {e}")))?;
        upsert_item(&source, &spec.items_key, &spec.id_field, item)?;
        notify_plugin_data(&app, &plugin_id, &rel);
        return Ok(json!({ "path": source.to_string_lossy(), "bytes": bytes.len(), "virtual": true, "id": id }));
    }

    let path = plugin_data_path(&app, &plugin_id, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("创建目录失败: {e}")))?;
    }
    std::fs::write(&path, &bytes).map_err(|e| err(format!("写入文件失败: {e}")))?;
    notify_plugin_data(&app, &plugin_id, &rel);
    Ok(json!({ "path": path.to_string_lossy(), "bytes": bytes.len(), "virtual": false }))
}

/// 删除一个 v3 文件（虚拟条目从源索引里删；常规文件直接删盘）。
#[tauri::command]
pub fn cloud_v3_file_delete(app: AppHandle, plugin_id: String, rel: String) -> Result<Value, String> {
    if !is_safe_id(&plugin_id) || !crate::plugin_host::is_safe_relative(&rel) {
        return Err(err("非法的插件文件路径"));
    }
    let specs = itemized_specs(&app, &plugin_id);
    if let Some((spec, id)) = itemized_virtual(&specs, &rel) {
        let source = plugin_data_path(&app, &plugin_id, &spec.source)?;
        let removed = remove_item(&source, &spec.items_key, &spec.id_field, &id)?;
        if removed {
            notify_plugin_data(&app, &plugin_id, &rel);
        }
        return Ok(json!({ "removed": removed, "virtual": true, "id": id }));
    }
    let path = plugin_data_path(&app, &plugin_id, &rel)?;
    let removed = std::fs::remove_file(&path).is_ok();
    if removed {
        notify_plugin_data(&app, &plugin_id, &rel);
    }
    Ok(json!({ "removed": removed, "virtual": false }))
}

/// 上传一个 blob（图片等二进制）。对象名只由内容摘要决定，跨插件全局去重。
#[tauri::command]
pub async fn cloud_v3_blob_put(
    app: AppHandle,
    plugin_id: String,
    rel: String,
) -> Result<Value, String> {
    if !is_safe_id(&plugin_id) || !crate::plugin_host::is_safe_relative(&rel) {
        return Err(err("非法的 blob 路径"));
    }
    let path = plugin_data_path(&app, &plugin_id, &rel)?;
    let (digest, bytes, raw) = file_digest(&path)?;
    if bytes > MAX_V3_FILE_BYTES {
        return Err(err(format!(
            "CLOUD_QUOTA: blob 过大（{} MB，上限 {} MB）",
            bytes / 1024 / 1024,
            MAX_V3_FILE_BYTES / 1024 / 1024
        )));
    }
    let object_rel = blob_rel(&digest)?;

    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(120)?;
        let meta = obj_meta(&client, &cfg, &creds, &object_rel).await?;
        if meta.exists {
            return Ok(json!({
                "rel": object_rel, "path": rel, "digest": digest, "bytes": meta.size.max(bytes),
                "uploaded": false,
            }));
        }
        let _ = obj_put(&client, &cfg, &creds, &object_rel, raw, Some(String::new())).await?;
        Ok(json!({
            "rel": object_rel, "path": rel, "digest": digest, "bytes": bytes, "uploaded": true,
        }))
    })
    .await
}

/// 下载 blob 并补回 `plugin-data/<id>/<rel>`（图片路径必须与条目里的 relPath 一致）。
#[tauri::command]
pub async fn cloud_v3_blob_get(
    app: AppHandle,
    plugin_id: String,
    rel: String,
    digest: String,
) -> Result<Value, String> {
    if !is_safe_id(&plugin_id)
        || !crate::plugin_host::is_safe_relative(&rel)
        || digest.len() != 64
        || !digest.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(err("非法的 blob 下载参数"));
    }
    let object_rel = blob_rel(&digest)?;
    let app_for_get = app.clone();
    let bytes = crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app_for_get);
        let client = build_client(120)?;
        let (bytes, _) = obj_get(&client, &cfg, &creds, &object_rel).await?;
        Ok::<Vec<u8>, String>(bytes)
    })
    .await?;
    if sha256_hex(&bytes) != digest {
        return Err(err("下载 blob 摘要不匹配，已拒绝写入"));
    }
    let path = plugin_data_path(&app, &plugin_id, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("创建目录失败: {e}")))?;
    }
    std::fs::write(&path, &bytes).map_err(|e| err(format!("写入 blob 失败: {e}")))?;
    notify_plugin_data(&app, &plugin_id, &rel);
    Ok(json!({ "path": path.to_string_lossy(), "bytes": bytes.len(), "digest": digest }))
}

/// 读 v3 提交点（不存在返回 `exists:false`）。
#[tauri::command]
pub async fn cloud_manifest_v3_get(app: AppHandle) -> Result<Value, String> {
    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        if cfg.webdav_url.trim().is_empty() {
            return Err(err("请先填写 WebDAV 地址"));
        }
        let client = build_client(60)?;
        match obj_get(&client, &cfg, &creds, MANIFEST_V3_REL).await {
            Ok((bytes, meta)) => {
                let manifest: Value = serde_json::from_slice(&bytes)
                    .map_err(|e| err(format!("云端 v3 manifest 解析失败: {e}")))?;
                Ok(json!({
                    "exists": true, "etag": meta.etag, "rev": meta.rev, "size": meta.size,
                    "modified": meta.modified, "manifest": manifest,
                }))
            }
            Err(e) if e.starts_with("CLOUD_NOT_FOUND") => {
                Ok(json!({ "exists": false, "manifest": Value::Null }))
            }
            Err(e) => Err(e),
        }
    })
    .await
}

/// 写 v3 提交点。`manifest-v3.json` 是唯一提交点；v2 `manifest.json` 不在这里写。
#[tauri::command]
pub async fn cloud_manifest_v3_put(
    app: AppHandle,
    manifest: Value,
    if_match: Option<String>,
) -> Result<Value, String> {
    if !manifest.is_object() {
        return Err(err("manifest 必须是对象"));
    }
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| err(format!("序列化 v3 manifest 失败: {e}")))?;
    if bytes.len() as u64 > MAX_MANIFEST_V3_BYTES {
        return Err(err(format!(
            "CLOUD_QUOTA: v3 manifest 过大（{} KB，上限 {} KB）",
            bytes.len() / 1024,
            MAX_MANIFEST_V3_BYTES / 1024
        )));
    }
    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(60)?;
        let guard = match if_match {
            Some(v) => Some(v),
            None => match obj_meta(&client, &cfg, &creds, MANIFEST_V3_REL).await {
                Ok(m) if m.exists && !m.etag.is_empty() => Some(m.etag),
                _ => None,
            },
        };
        let meta = obj_put(&client, &cfg, &creds, MANIFEST_V3_REL, bytes, guard).await?;
        Ok(json!({ "ok": true, "etag": meta.etag, "rev": meta.rev, "size": meta.size, "modified": meta.modified }))
    })
    .await
}

/// 计算本机各分片摘要（不联网）。
///
/// 入参是**已经按分片切好的** localStorage 子集：
/// `{"core":{...}, "plugins":{"<id>":{...}}}` —— 切片逻辑在前端 `snapshot.ts`
/// （那里已经知道哪些键属于插件），Rust 只按给定的片算摘要。
#[tauri::command]
pub fn cloud_digests(app: AppHandle, local_storage: Value) -> Result<Value, String> {
    let core_ls = local_storage.get("core").cloned().unwrap_or(Value::Null);
    let plugin_ls = local_storage.get("plugins").cloned().unwrap_or(json!({}));
    let settings = crate::read_backup_settings(&app);

    let (core_digest, core_bytes, core_files) =
        digest_scope(&app, "core", &core_ls, Some(&settings))?;
    let mut plugins = serde_json::Map::new();
    for id in crate::backup::syncable_plugin_ids(&app)? {
        let ls = plugin_ls.get(&id).cloned().unwrap_or(Value::Null);
        let (body_digest, body_bytes, body_files) = digest_scope(&app, &format!("body:{id}"), &Value::Null, None)?;
        let (data_digest, data_bytes, data_files) = digest_scope(&app, &format!("data:{id}"), &ls, None)?;
        plugins.insert(
            id,
            json!({
                "body": { "digest": body_digest, "bytes": body_bytes, "files": body_files },
                "data": { "digest": data_digest, "bytes": data_bytes, "files": data_files },
            }),
        );
    }
    Ok(json!({
        "core": { "digest": core_digest, "bytes": core_bytes, "files": core_files },
        "plugins": plugins,
        "appVersion": app_version(&app),
        "at": now_ms(),
    }))
}

/// 打包并上传一个分片对象（按摘要命名，已存在则跳过）。
#[tauri::command]
pub async fn cloud_shard_put(
    app: AppHandle,
    scope: String,
    local_storage: Value,
) -> Result<Value, String> {
    if !(scope == "core" || scope.starts_with("body:") || scope.starts_with("data:")) {
        return Err(err("未知分片"));
    }
    let settings = crate::read_backup_settings(&app);
    let use_settings = if scope == "core" { Some(settings) } else { None };
    let use_ls = if local_storage.is_object() { Some(local_storage) } else { None };

    let files = files_for_scope(&app, &scope)?;
    let (digest, bytes) =
        crate::backup::shard_digest(&files, use_ls.as_ref(), use_settings.as_ref())?;
    if bytes > MAX_SHARD_BYTES {
        return Err(err(format!(
            "CLOUD_QUOTA: 分片过大（{} MB，上限 {} MB）",
            bytes / 1024 / 1024,
            MAX_SHARD_BYTES / 1024 / 1024
        )));
    }
    let rel = shard_rel(&scope, &digest)?;

    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(180)?;

        // 已存在（同内容）→ 直接复用，不做重复上传
        let meta = obj_meta(&client, &cfg, &creds, &rel).await?;
        if meta.exists {
            return Ok(json!({
                "rel": rel, "digest": digest, "bytes": meta.size.max(bytes), "uploaded": false,
                "scope": scope, "pluginId": scope_label(&scope),
            }));
        }

        // 打包到备份目录（同目录写临时文件，失败不污染）
        let dir = std::path::PathBuf::from(crate::backup::backups_dir_path(&app)?);
        std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建目录失败: {e}")))?;
        let tmp = dir.join(format!(
            ".cloud-tmp-{}.msbackup",
            digest.chars().take(16).collect::<String>()
        ));
        crate::backup::write_archive_file_from_files(
            &tmp,
            use_ls.clone().unwrap_or(Value::Null),
            use_settings.clone().unwrap_or(Value::Null),
            &files,
            &app_version(&app),
        )?;
        let payload = std::fs::read(&tmp).map_err(|e| err(format!("读取分片失败: {e}")))?;
        let _ = std::fs::remove_file(&tmp);

        let result = obj_put(&client, &cfg, &creds, &rel, payload, Some(String::new())).await;
        let uploaded = match result {
            Ok(_) => true,
            Err(e) if e.starts_with("CLOUD_EXISTS") => false, // 另一台设备刚好传了同内容
            Err(e) => return Err(e),
        };
        Ok(json!({
            "rel": rel, "digest": digest, "bytes": bytes, "uploaded": uploaded,
            "scope": scope, "pluginId": scope_label(&scope),
        }))
    })
    .await
}

/// 下载一个分片对象到备份目录，返回可直接交给 `backup_restore` 的绝对路径。
#[tauri::command]
pub async fn cloud_shard_get(app: AppHandle, rel: String) -> Result<Value, String> {
    let rel = clean_rel(&rel)?;
    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(180)?;
        let (bytes, meta) = obj_get(&client, &cfg, &creds, &rel).await?;
        if bytes.is_empty() {
            return Err(err("云端分片为空"));
        }
        let dir = std::path::PathBuf::from(crate::backup::backups_dir_path(&app)?);
        std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建目录失败: {e}")))?;
        let name = format!(
            "cloud-shard-{}.msbackup",
            rel.replace(['/', '\\', ':'], "-")
        );
        let path = dir.join(name);
        std::fs::write(&path, &bytes).map_err(|e| err(format!("写入分片失败: {e}")))?;
        Ok(json!({
            "path": path.to_string_lossy().to_string(),
            "bytes": bytes.len() as u64,
            "rev": meta.rev,
            "etag": meta.etag,
            "rel": rel,
        }))
    })
    .await
}

/// 删除云端对象（清空某插件云端数据 / GC 用）
#[tauri::command]
pub async fn cloud_object_delete(app: AppHandle, rel: String) -> Result<Value, String> {
    let rel = clean_rel(&rel)?;
    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(60)?;
        let removed = obj_delete(&client, &cfg, &creds, &rel).await?;
        Ok(json!({ "rel": rel, "removed": removed }))
    })
    .await
}

/// 列出某个云端分片里的**具体条目**（文件名 + 大小）。
///
/// 用途：面板「查看云端内容」。只在用户点开时调用，按需下载该分片后解析
/// ZIP 条目；不把 manifest 撑大（manifest 只存摘要/体积，不存文件清单）。
#[tauri::command]
pub async fn cloud_shard_inspect(app: AppHandle, rel: String) -> Result<Value, String> {
    const MAX_ENTRIES: usize = 2000;
    // 「查看内容」是探索性操作：超过这个体积就别整片下载了（用户应改用「下载数据」）
    const INSPECT_LIMIT: u64 = 64 * 1024 * 1024;
    let rel = clean_rel(&rel)?;
    crate::sync_service::with_sync_gate(async move {
        let (cfg, creds) = cfg_pair(&app);
        let client = build_client(120)?;
        let meta = obj_meta(&client, &cfg, &creds, &rel).await?;
        if !meta.exists {
            return Err("云端没有这个分片".to_string());
        }
        if meta.size > INSPECT_LIMIT {
            return Err(format!(
                "分片 {} MB，超出查看上限（{} MB）；如需落地请点「下载数据」",
                meta.size / (1024 * 1024),
                INSPECT_LIMIT / (1024 * 1024)
            ));
        }
        let (bytes, meta) = obj_get(&client, &cfg, &creds, &rel).await?;
        let entries = crate::backup::read_archive_public(&bytes)?;
        let mut list: Vec<Value> = Vec::new();
        let mut total: u64 = 0;
        let mut truncated = false;
        for (name, data) in entries {
            if list.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            total += data.len() as u64;
            list.push(json!({ "name": name, "size": data.len() }));
        }
        Ok(json!({
            "rel": rel,
            "bytes": meta.size.max(bytes.len() as u64),
            "totalBytes": total,
            "entries": list,
            "truncated": truncated,
        }))
    })
    .await
}

/// 配额常量（面板展示用；前端不写死数字）
#[tauri::command]
pub fn cloud_quota() -> Value {
    json!({
        "pluginBytes": PLUGIN_QUOTA_BYTES,
        "shardBytes": MAX_SHARD_BYTES,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        blob_rel, clean_rel, encode_segment, inline_text, item_matches_filter,
        itemized_entries_from_root, itemized_selected_blob_paths, itemized_specs_from,
        itemized_virtual, is_safe_id, now_ms, remove_item, shard_rel, upsert_item, v3_file_rel,
        ItemizedSpec,
    };
    use serde_json::{json, Value};

    #[test]
    fn rejects_unsafe_object_paths() {
        assert!(clean_rel("../evil").is_err());
        assert!(clean_rel("plugins/../../x").is_err());
        assert!(clean_rel("http://evil/x").is_err());
        assert!(clean_rel("other/x.msbackup").is_err());
        assert!(clean_rel("plugins/demo/body-abc.msbackup").is_ok());
        assert!(clean_rel("manifest.json").is_ok());
    }

    #[test]
    fn builds_stable_shard_paths() {
        assert_eq!(shard_rel("core", "abc").unwrap(), "core-abc.msbackup");
        assert_eq!(
            shard_rel("data:todo-list", "abc").unwrap(),
            "plugins/todo-list/data-abc.msbackup"
        );
        assert_eq!(
            shard_rel("body:todo-list", "abc").unwrap(),
            "plugins/todo-list/body-abc.msbackup"
        );
    }

    #[test]
    fn plugin_ids_are_sane() {
        assert!(is_safe_id("todo-list"));
        assert!(!is_safe_id("../x"));
        assert!(!is_safe_id(".hidden"));
        assert!(!is_safe_id(""));
    }

    #[test]
    fn encodes_path_segments() {
        assert_eq!(encode_segment("a b"), "a%20b");
        assert_eq!(encode_segment("a-b_c.d"), "a-b_c.d");
    }

    #[test]
    fn v3_object_names_are_digest_addressed() {
        let digest = "a".repeat(64);
        assert_eq!(blob_rel(&digest).unwrap(), format!("blobs/aa/{digest}"));
        let rel = v3_file_rel("com.mysearch.clipboard", "clipboard/items/a.json", &digest).unwrap();
        assert!(rel.starts_with("plugins/com.mysearch.clipboard/files/"));
        assert!(rel.ends_with(&format!("-{digest}.msf")));
        assert!(v3_file_rel("bad/id", "x", &digest).is_err());
        assert!(v3_file_rel("p", "../x", &digest).is_err());
    }

    #[test]
    fn v3_inline_only_for_small_text() {
        assert_eq!(inline_text(b"{\"a\":1}").as_deref(), Some("{\"a\":1}"));
        assert!(inline_text(&vec![b'x'; 2049]).is_none());
        assert!(inline_text(&[0xff, 0xfe]).is_none());
    }

    #[test]
    fn v3_itemized_paths_are_virtual() {
        let specs = vec![ItemizedSpec {
            source: "clipboard/index.json".into(),
            dir: "clipboard/items".into(),
            items_key: "items".into(),
            id_field: "id".into(),
            filter: None,
            blob_fields: Vec::new(),
        }];
        let (spec, id) = itemized_virtual(&specs, "clipboard/items/a.json").unwrap();
        assert_eq!(spec.dir, "clipboard/items");
        assert_eq!(id, "a");
        assert!(itemized_virtual(&specs, "clipboard/items/a/b.json").is_none());
        assert!(itemized_virtual(&specs, "clipboard/index.json").is_none());
    }

    #[test]
    fn v3_itemized_filter_only_selects_retained_and_its_blobs() {
        let policy = json!({
            "itemized": [{
                "file": "clipboard/index.json",
                "itemsKey": "items",
                "idField": "id",
                "dir": "clipboard/items",
                "filter": { "retained": true },
                "blobFields": ["relPath"]
            }]
        });
        let specs = itemized_specs_from(&policy);
        assert_eq!(specs.len(), 1);
        let spec = &specs[0];
        assert_eq!(spec.filter, Some(json!({ "retained": true })));
        assert_eq!(spec.blob_fields, vec!["relPath".to_string()]);
        let root = json!({
            "items": [
                { "id": "fav", "retained": true, "relPath": "clipboard/fav.png" },
                { "id": "tmp", "retained": false, "relPath": "clipboard/tmp.png" },
                { "id": "cat", "retained": true, "relPath": "../escape.png" }
            ]
        });
        assert!(item_matches_filter(
            &root["items"][0],
            &Some(json!({ "retained": true }))
        ));
        assert!(!item_matches_filter(
            &root["items"][1],
            &Some(json!({ "retained": true }))
        ));
        let paths = itemized_selected_blob_paths(&root, spec);
        assert_eq!(paths.len(), 1);
        assert!(paths.contains("clipboard/fav.png"));
        assert!(!paths.contains("clipboard/tmp.png"));
        let entries = itemized_entries_from_root(&root, spec);
        assert_eq!(entries.len(), 2, "收藏/分类条目都进 manifest，与图片路径安全无关");
        let paths: Vec<&str> = entries
            .iter()
            .filter_map(|e| e.get("path").and_then(|v| v.as_str()))
            .collect();
        assert!(paths.contains(&"clipboard/items/fav.json"));
        assert!(paths.contains(&"clipboard/items/cat.json"));
        assert!(!paths.contains(&"clipboard/items/tmp.json"));
    }

    #[test]
    fn v3_item_upsert_and_remove() {
        let path = std::env::temp_dir().join(format!(
            "my-search-v3-items-{}-{}.json",
            std::process::id(),
            now_ms()
        ));
        std::fs::write(&path, r#"{"items":[]}"#).unwrap();
        upsert_item(
            &path,
            "items",
            "id",
            json!({"id":"a","text":"A","createdAt":1}),
        )
        .unwrap();
        upsert_item(
            &path,
            "items",
            "id",
            json!({"id":"b","text":"B","createdAt":2}),
        )
        .unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let items = root.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].get("id").and_then(|v| v.as_str()), Some("b")); // createdAt 倒序
        upsert_item(
            &path,
            "items",
            "id",
            json!({"id":"a","text":"A2","createdAt":1}),
        )
        .unwrap();
        assert_eq!(
            remove_item(&path, "items", "id", "b").unwrap(),
            true
        );
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let items = root.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("text").and_then(|v| v.as_str()), Some("A2"));
        let _ = std::fs::remove_file(path);
    }
}
