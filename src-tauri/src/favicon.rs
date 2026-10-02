//! favicon 拉取：把结果列表图标的加载从 WebView 搬到 Rust。
//!
//! 背景：图标此前由前端 WebView 用 `<img>` / `new Image()` **直接加载**，而
//! WebView2 会**无条件跟随操作系统代理**，不受应用内「规则代理」约束——于是
//! 电脑上开着代理软件时图标会被代理拦掉、关掉代理软件又正常，而应用里的
//! 「代理总开关 / 规则」对它毫无作用（这正是用户反馈的现象）。
//!
//! 改由 Rust 拉取后，图标请求与其它后端请求（`http_get` / `http_request` 等）
//! 走**同一套规则代理**：命中规则才走系统代理，其余直连；这样一来
//! - 「代理总开关关闭 → 全部直连」对图标同样生效；
//! - 想让某个图标服务走代理，把它加进自定义规则即可。
//!
//! 前端传入候选源列表（favicon 服务的多级回退顺序，见 `src/windows/search/
//! favicon.ts`），Rust 依次尝试，成功即返回 `data:<mime>;base64,…`；前端 `<img>`
//! 直接吃 data URL，此后不再发起任何网络请求。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// 单个图标的体积上限（图标很小；超过基本可判为被代理/门户塞了个 HTML 页面）。
const MAX_FAVICON_BYTES: u64 = 512 * 1024;
/// 结果缓存条数上限（超出整体清空：够用且实现简单）。
const MAX_CACHE_ENTRIES: usize = 512;

/// 成功结果缓存：候选列表指纹 → data URL。
///
/// 搬到 Rust 后失去了 WebView 自带的 HTTP 缓存，这里按「候选列表」缓存成功
/// 结果，避免同一域名在每次搜索时重复拉取。**只缓存成功**，因此代理规则 /
/// 系统代理变化后不会残留「旧的失败结论」。
static CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 依次尝试候选源，返回首个成功的 data URL；全部失败返回 `None`。
pub(crate) async fn fetch(candidates: &[String]) -> Option<String> {
    if candidates.is_empty() {
        return None;
    }
    let key = candidates.join("|");
    if let Some(hit) = CACHE.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Some(hit);
    }

    for url in candidates {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            continue;
        }
        if let Some(data_url) = fetch_one(url).await {
            if let Ok(mut c) = CACHE.lock() {
                if c.len() >= MAX_CACHE_ENTRIES {
                    c.clear();
                }
                c.insert(key, data_url.clone());
            }
            return Some(data_url);
        }
    }
    None
}

/// 拉取单个候选源并按魔数转成 data URL（失败/超限返回 None）。
async fn fetch_one(url: &str) -> Option<String> {
    // 短超时：结果列表可能有很多条，不能让个别慢源拖住整屏图标。
    let client = crate::build_client(8, crate::UA).ok()?;
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    // 先看 Content-Length 快速拒绝；即便如此，下面仍按流式**边读边限**，
    // 防止无 Content-Length 的分块传输把超大响应全读进内存。
    if let Some(cl) = resp.content_length() {
        if cl > MAX_FAVICON_BYTES {
            return None;
        }
    }

    use futures_util::StreamExt;
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if buf.len() as u64 + chunk.len() as u64 > MAX_FAVICON_BYTES {
            return None;
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return None;
    }

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Some(format!("data:{};base64,{b64}", sniff_mime(&buf)))
}

/// 由魔数猜 MIME（图标源常见 png / ico / jpeg / gif / webp / svg）。
fn sniff_mime(b: &[u8]) -> &'static str {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        "image/x-icon"
    } else if b.starts_with(b"<svg") || b.starts_with(b"<?xml") || b.starts_with(b"<SVG") {
        "image/svg+xml"
    } else {
        // 兜底：多数图标服务返回 png 且可能无魔数前缀（极少见）
        "image/png"
    }
}

#[cfg(test)]
mod tests {
    use super::sniff_mime;

    #[test]
    fn sniff_common_image_signatures() {
        assert_eq!(sniff_mime(&[0x89, b'P', b'N', b'G', 0x0D]), "image/png");
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff_mime(b"GIF89a..."), "image/gif");
        assert_eq!(sniff_mime(b"\x00\x00\x01\x00rest"), "image/x-icon");
        assert_eq!(sniff_mime(b"<svg xmlns=\"...\">"), "image/svg+xml");
        assert_eq!(sniff_mime(b"RIFF____WEBPVP8 "), "image/webp");
    }
}
