//! 插件市场下载（Rust 侧第二道防线）。
//!
//! 职责：`market_fetch_raw` 是市场插件里「下载 .msplugin 安装包」的唯一通道。
//! 前端（市场 UI）先做了权限与目录校验，这里在**前端被自动绕过的假设**下
//! 再做一次深防（与 `plugin_net_fetch` 同一哲学）：
//!
//! 1. **调用者身份**：只有「已启用 + 授予 `plugin.install`」的插件才能下载
//!    （网关镜像 `plugin-gateway.json` 由前端同步而来，Rust 侧读内存镜像）；
//! 2. **源受限**：`url` 必须以白名单 base 为前缀（默认官方发布地址，可用
//!    环境变量 `MY_SEARCH_MARKET_BASES` 覆盖，逗号分隔）——目录被攻破时
//!    下载也只能落在受控前缀内，SSRF 面归零；
//! 3. **完整性**：下载完成在 Rust 侧再验一次 sha256（前端验完这里还验），
//!    返回 body 打包成 base64（与 `plugin_read_local_base64` / `InstallFile`
//!    的既有传输形态一致，避免大数组 JSON 的 IPC 膨胀）。

use base64::Engine as _;

/// 默认市场发布前缀（Task 10 的目录仓库 Release 下载根）
const DEFAULT_MARKET_BASE: &str =
    "https://github.com/My-Search/my-search-plugin-market/releases/download";
/// 覆盖默认前缀的环境变量名（逗号分隔多个，便于本地目录服务/镜像调试）
const MARKET_BASES_ENV: &str = "MY_SEARCH_MARKET_BASES";
/// 单个安装包体积上限（与 plugin_host 的 MAX_FILE_BYTES 对齐）
const MAX_MARKET_PACKET_BYTES: u64 = 64 * 1024 * 1024;

// ===================== 白名单 =====================

/// base 合法性：必须 https，且不含用户信息段（@）。
/// http 仅允许 localhost/127.0.0.1（本地目录服务调试用），与目录 schema 同一口径。
fn is_valid_base(base: &str) -> bool {
    if base.is_empty() {
        return false;
    }
    if let Some(rest) = base.strip_prefix("https://") {
        return !rest.is_empty() && !rest.contains('@');
    }
    if let Some(rest) = base.strip_prefix("http://") {
        let host = rest
            .split('/')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("");
        return host == "localhost" || host == "127.0.0.1";
    }
    false
}

/// 从环境变量原文解析 base 列表：未设置 → 默认；设置了 → 逐项过滤非法 base。
/// 过滤不是降级：环境变量给了一串但全是非法项时返回空列表（= 全部下载被拒，更安全）。
fn parse_market_bases(env_text: &str) -> Vec<String> {
    let trimmed: Vec<&str> = env_text
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let candidates: Vec<&str> = if trimmed.is_empty() {
        vec![DEFAULT_MARKET_BASE]
    } else {
        trimmed
    };
    candidates
        .into_iter()
        .filter(|b| is_valid_base(b))
        .map(|s| s.to_string())
        .collect()
}

fn market_bases() -> Vec<String> {
    match std::env::var(MARKET_BASES_ENV) {
        Ok(v) => parse_market_bases(&v),
        Err(_) => parse_market_bases(""),
    }
}

/// `url` 是否落在 `base` 受控前缀内（前缀边界校验，防 `.../download-evil`）。
fn is_url_under_base(url: &str, base: &str) -> bool {
    if base.is_empty() || !url.starts_with(base) {
        return false;
    }
    let rest = &url[base.len()..];
    rest.is_empty() || rest.starts_with('/')
}

// ===================== 准入（权限门） =====================

/// 准入判定（纯函数便于单测）：插件必须启用且授予 `plugin.install`。
fn market_gate_allows(spec: &crate::plugin_host::GatewaySpec) -> bool {
    spec.enabled
        && spec
            .grants
            .iter()
            .any(|g| g.split(':').next() == Some("plugin.install"))
}

// ===================== sha256 完整性 =====================

/// 目录/前端都是 64 位小写 hex；Rust 侧宽容大小写（比较时不区分）。
fn is_valid_sha256(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ===================== 命令 =====================

/// 下载一个市场安装包（base64 返回，与既有安装管线同形态）。
///
/// - `plugin_id`：调用者身份（调用方前端把自己的 id 传过来，Rust 侧据网关
///   镜像复核权限——前端被绕开的假设下仍拒掉无 `plugin.install` 的调用）；
/// - `url`：完整下载地址，必须落在白名单 base 之下；
/// - `expected_sha256`：目录条目里的包摘要，下载后在这里再验一次。
#[tauri::command]
pub(crate) async fn market_fetch_raw(
    plugin_id: String,
    url: String,
    expected_sha256: String,
) -> Result<String, String> {
    let spec = crate::plugin_host::gateway_get(&plugin_id)
        .ok_or_else(|| format!("插件未注册到网关: {plugin_id}"))?;
    if !market_gate_allows(&spec) {
        return Err("插件未获授权「安装与更新插件」（plugin.install）".into());
    }

    if !is_valid_sha256(&expected_sha256) {
        return Err("sha256 校验值必须是 64 位十六进制".into());
    }
    let bases = market_bases();
    if !bases.iter().any(|b| is_url_under_base(&url, b)) {
        return Err(format!("下载地址不在允许的市场前缀内: {url}"));
    }

    let client = crate::build_client(120, crate::UA)?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败（HTTP {}）", resp.status().as_u16()));
    }
    if let Some(cl) = resp.content_length() {
        if cl > MAX_MARKET_PACKET_BYTES {
            return Err(format!("安装包过大（{} 字节），超过 64MB 上限", cl));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取下载内容失败: {e}"))?
        .to_vec();
    if bytes.len() as u64 > MAX_MARKET_PACKET_BYTES {
        return Err("安装包过大（超过 64MB 上限）".into());
    }

    let actual = sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(&expected_sha256) {
        return Err("下载内容 sha256 校验失败（可能已被篡改，或目录数据过期）".into());
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// ===================== 测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_host::GatewaySpec;

    #[test]
    fn market_bases_defaults_when_env_absent() {
        let bases = parse_market_bases("");
        assert_eq!(bases.len(), 1, "未配置时应取默认 base");
        assert_eq!(bases[0], DEFAULT_MARKET_BASE);
    }

    #[test]
    fn market_bases_splits_env_and_filters_invalid() {
        let bases = parse_market_bases(" https://a.example.com/x ,javascript:alert(1),https://b.example.com/y ");
        assert_eq!(bases.len(), 2, "非法项被过滤，http 非 localhost 也一样");
        assert!(bases.iter().any(|b| b == "https://a.example.com/x"));
        assert!(bases.iter().any(|b| b == "https://b.example.com/y"));
    }

    #[test]
    fn market_bases_env_all_invalid_blocks_everything() {
        // 不是降级：全非法 → 空列表 = 全部拒绝
        let bases = parse_market_bases("http://evil.com/x,ftp://x/y");
        assert!(bases.is_empty());
    }

    #[test]
    fn localhost_http_base_allowed_for_debug() {
        assert!(is_valid_base("http://localhost:8000/"));
        assert!(is_valid_base("http://127.0.0.1:8000/"));
        assert!(!is_valid_base("http://github.com/x"));
    }

    #[test]
    fn base_rejects_userinfo_and_bad_schemes() {
        assert!(!is_valid_base("https://user@github.com/x"));
        assert!(!is_valid_base("javascript:alert(1)"));
        assert!(!is_valid_base(""));
        assert!(!is_valid_base("file:///etc/passwd"));
    }

    #[test]
    fn url_must_stay_under_base() {
        let base = "https://github.com/org/market/releases/download";
        assert!(is_url_under_base(
            "https://github.com/org/market/releases/download/com.a.msplugin",
            base
        ));
        assert!(is_url_under_base(
            "https://github.com/org/market/releases/download",
            base
        ));
        // 前缀边界：download-evil 不能被 download 覆盖
        assert!(!is_url_under_base(
            "https://github.com/org/market/releases/downloadevil/com.a.msplugin",
            base
        ));
        // 主机不同 / 协议降级
        assert!(!is_url_under_base(
            "https://evil.com/org/market/releases/download/x",
            base
        ));
        assert!(!is_url_under_base(
            "http://github.com/org/market/releases/download/x",
            base
        ));
    }

    #[test]
    fn sha256_hex_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_format_is_64_hex() {
        assert!(is_valid_sha256(&"a".repeat(64)));
        assert!(!is_valid_sha256(&"a".repeat(63)));
        assert!(!is_valid_sha256(&"zz".repeat(32)));
        assert!(!is_valid_sha256(""));
    }

    #[test]
    fn market_gate_requires_enabled_and_plugin_install() {
        let granted = GatewaySpec {
            plugin_id: "com.mysearch.market".into(),
            enabled: true,
            grants: vec!["ui.inlay".into(), "plugin.install".into()],
            ..Default::default()
        };
        assert!(market_gate_allows(&granted));

        let no_grant = GatewaySpec {
            plugin_id: "com.a.demo".into(),
            enabled: true,
            grants: vec!["ui.inlay".into()],
            ..Default::default()
        };
        assert!(!market_gate_allows(&no_grant));

        let disabled = GatewaySpec {
            plugin_id: "com.mysearch.market".into(),
            enabled: false,
            grants: vec!["plugin.install".into()],
            ..Default::default()
        };
        assert!(!market_gate_allows(&disabled));
    }
}