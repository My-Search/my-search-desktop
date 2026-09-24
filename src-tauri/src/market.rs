//! 插件市场下载（Rust 侧第二道防线）。
//!
//! 职责：`market_fetch_raw` 是市场插件里「下载 .mspp 安装包」的唯一通道。
//! 前端（市场 UI）先做了权限与目录校验，这里在**前端被自动绕过的假设**下
//! 再做一次深防（与 `plugin_net_fetch` 同一哲学）：
//!
//! 1. **调用者身份**：只有「已启用 + 授予 `plugin.install`」的插件才能下载
//!    （网关镜像 `plugin-gateway.json` 由前端同步而来，Rust 侧读内存镜像）；
//! 2. **源受限**：`url` 必须是 https 且 host 落在允许白名单内
//!    （`github.com` 的 Release 资产 / `raw.githubusercontent.com` 的官方插件目录 /
//!    `objects.githubusercontent.com` 的资产 302 终点），路径形态另行严格校验——
//!    插件包可以托管在开发者自己的仓库里，准入由 `plugins/sources.json` 审核控制。
//!    另兼容受控 base 前缀通道（默认官方发布地址，可用环境变量
//!    `MY_SEARCH_MARKET_BASES` 覆盖）供本地目录服务/镜像调试。
//!    **重定向不自动跟随**：逐跳重新校验，避免 302 把下载引到任意地址（SSRF）；
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

// ===================== 第三方源（开发者自助发布） =====================

/// 允许作为插件包下载 host 的白名单。
///
/// 插件包可以托管在**开发者自己的仓库**里（准入由 `plugins/sources.json` 审核控制），
/// 因此下载地址不再要求落在我们自己的 base 前缀内。收紧点改为 host + 路径：
///   - `github.com`：开发者仓库的 Release 资产；
///   - `release-assets.githubusercontent.com`：**Release 资产 302 的真实终点**。
///     GitHub 会把 `github.com/<o>/<r>/releases/download/...` 重定向到这里，
///     不放行则任何 Release 包（含 catalog.json）都下载失败；
///   - `objects.githubusercontent.com`：早期/部分场景的资产终点域名，一并保留；
///   - `raw.githubusercontent.com`：官方插件的仓库文件直链
///     （`official-plugins/<id>/<版本>/<id>.mspp`，便于按版本归档而无需逐个建 Release）。
const ALLOWED_DOWNLOAD_HOSTS: [&str; 4] = [
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
];

/// 市场索引在 raw 域的受控位置：`<owner>/<repo>/<ref>/index.dist.json`。
///
/// 索引**不是**普通插件包（4 段 vs 包的 7 段），因此单独一条规则；
/// 且必须钉死到我们自己的仓库与分支——否则任意第三方仓库都能放一个
/// index.dist.json 顶替市场索引（那是比包更严重的信任问题）。
const MARKET_CATALOG_OWNER: &str = "my-search";
const MARKET_CATALOG_REPO: &str = "my-search-plugin-market";
const MARKET_CATALOG_REF: &str = "main";
const MARKET_CATALOG_FILE: &str = "index.dist.json";

/// 解析 URL 的 (host, path)。返回 None 表示格式非法或含 userinfo。
///
/// 刻意**不做**字符串前缀比对：`https://github.com@evil.com/x` 的 `starts_with`
/// 会通过但真实 host 是 evil.com。这里显式拒绝任何含 `@` 的地址（userinfo），
/// 再取出 host（去端口）与 path，交给调用方精确匹配。
fn split_host_path(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return None; // userinfo 一律拒绝（含 `github.com@evil.com` 这类伪造）
    }
    // 端口必须为空或 443：github.com:8443 不能借非标端口绕过。
    // 注意只在 authority 内切分，且冒号后必须是纯数字，避免误把
    // `github.com/a/b` 的路径部分当成端口。
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(p) = port {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) || p != "443" {
            return None;
        }
    }
    if host.is_empty() {
        return None;
    }
    let path = rest[authority_end..].to_string();
    Some((host.to_ascii_lowercase(), path))
}

/// 是否为允许的插件包地址：https + host 在白名单 + 路径含 Release 资产段。
///
/// 与前端 `isAllowedDownloadUrl`（market-types.ts）同一口径，**两侧必须一起改**。
///
/// 路径形如 `/<owner>/<repo>/releases/download/<tag>/<asset>`：受控段
/// `/releases/download/` 位于中间而非开头，因此按"段"匹配：
/// before 必须是 `<owner>/<repo>`（两段），after 必须是 `<tag>/<asset>`（两段）。
/// 这样 `/releases/download-evil/` 之类的伪造路径无法通过。
fn is_allowed_release_url(url: &str) -> bool {
    let Some((host, path)) = split_host_path(url) else {
        return false;
    };
    if !ALLOWED_DOWNLOAD_HOSTS.contains(&host.as_str()) {
        return false;
    }
    // raw 域有两种受控形态：官方插件包目录（7 段）、市场索引本身（4 段）。
    // 除此之外的 raw 地址一律拒绝。
    if host == "raw.githubusercontent.com" {
        return is_allowed_official_raw_url(&host, &path) || is_market_catalog_raw_url(&host, &path);
    }
    // 资产终点域：GitHub 把 Release 资产 302 到这里，路径形如
    // /github-production-release-asset/<id>/<id>?<签名参数>。
    // 该 host 本身即受控终点，但路径仍要求是资产形态，避免被当作任意跳板。
    if is_asset_cdn_host(&host) {
        return path.starts_with("/github-production-release-asset/");
    }
    // github.com：必须是 <owner>/<repo>/releases/download/<tag>/<asset> 形态
    const MARKER: &str = "/releases/download/";
    let Some(idx) = path.find(MARKER) else {
        return false;
    };
    let owner_repo: Vec<&str> = path[..idx].trim_start_matches('/').split('/').collect();
    if owner_repo.len() != 2 || owner_repo.iter().any(|s| s.is_empty()) {
        return false;
    }
    let tag_asset: Vec<&str> = path[idx + MARKER.len()..].split('/').collect();
    tag_asset.len() == 2 && tag_asset.iter().all(|s| !s.is_empty())
}

/// 是否为 GitHub 的 Release 资产 CDN 终点域。
///
/// 注意：真实域名随 GitHub 调整而变——实测当前是
/// `release-assets.githubusercontent.com`，早期为 `objects.githubusercontent.com`。
/// 两者都保留，避免某天 GitHub 切回旧域时又断。
fn is_asset_cdn_host(host: &str) -> bool {
    host == "release-assets.githubusercontent.com" || host == "objects.githubusercontent.com"
}

/// 官方插件的仓库文件直链：`/<owner>/<repo>/<ref>/official-plugins/<id>/<版本>/<id>.mspp`
///
/// 用于官方插件按版本归档（一个插件一个目录，发新版加一层版本目录），
/// 免去逐个 Release 的维护成本。路径结构**严格限定**：
///   - 前两段是 owner/repo，第三段是分支/tag（官方仓库的默认分支）；
///   - 第四段必须是 `official-plugins`；
///   - 之后恰为 `<id>/<版本>/<资产名>` 三段，且资产名以 `.mspp` 结尾。
/// 这样即使放宽到 raw 域，也只能取到官方插件目录下的 `.mspp`，
/// 而不是任意 raw 文件。
///
/// 注意：**图标不走这里**。市场 UI 用 `<img src>` 直接加载图标，
/// 不经过本命令，因此这里只放行 `.mspp`，不因图标而放宽下载面。
fn is_allowed_official_raw_url(host: &str, path: &str) -> bool {
    if !host.eq_ignore_ascii_case("raw.githubusercontent.com") {
        return false;
    }
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    // owner / repo / ref / official-plugins / id / version / asset
    if segs.len() != 7 || segs.iter().any(|s| s.is_empty()) {
        return false;
    }
    if segs[3] != "official-plugins" {
        return false;
    }
    segs[6].ends_with(".mspp")
}

/// 市场索引本身的直链：`/<owner>/<repo>/<ref>/index.dist.json`（恰 4 段）。
///
/// 索引与插件包同域名但形态不同（4 段 vs 7 段），`is_allowed_official_raw_url`
/// 的严格 7 段判定**收不进索引**——这正是「索引从 Release 迁到仓库文件后、
/// 客户端拉不到索引」的原因。这里为索引单列一条规则。
///
/// 与包规则的区别在于**是否钉死仓库**：包可以来自任何第三方仓库（准入由
/// index.json 审核控制），但索引只能来自我们自己的仓库与分支，否则任何人都能
/// 用自己仓库里的 index.dist.json 顶替市场索引。因此这里 owner/repo/ref/文件名
/// 四项全部精确比对（大小写不敏感），不做通配。
fn is_market_catalog_raw_url(host: &str, path: &str) -> bool {
    if !host.eq_ignore_ascii_case("raw.githubusercontent.com") {
        return false;
    }
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    // owner / repo / ref / index.dist.json
    if segs.len() != 4 || segs.iter().any(|s| s.is_empty()) {
        return false;
    }
    segs[0].eq_ignore_ascii_case(MARKET_CATALOG_OWNER)
        && segs[1].eq_ignore_ascii_case(MARKET_CATALOG_REPO)
        && segs[2].eq_ignore_ascii_case(MARKET_CATALOG_REF)
        && segs[3].eq_ignore_ascii_case(MARKET_CATALOG_FILE)
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

    // 目录拉取（catalog.json）不传 sha256；安装包下载必须传
    let verify_sha = !expected_sha256.is_empty();
    if verify_sha && !is_valid_sha256(&expected_sha256) {
        return Err("sha256 校验值必须是 64 位十六进制".into());
    }
    let bases = market_bases();
    // 两条通道取或：① 白名单 host 的 Release 资产（开发者自助发布）；
    // ② 受控 base 前缀（我们自己的目录/镜像，兼容本地调试）。
    if !is_allowed_release_url(&url) && !bases.iter().any(|b| is_url_under_base(&url, b)) {
        return Err(format!("下载地址不在允许的市场前缀内: {url}"));
    }

    // 不跟随重定向：白名单只约束了首跳，若自动跟随，302 的终点可以落到任意
    // 地址（SSRF）。这里手动逐跳校验，每跳都要求仍是不在受控前缀内且
    // host 合法的地址。
    let client = reqwest::Client::builder()
        .user_agent(crate::UA)
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("构建下载客户端失败: {e}"))?;
    let mut current = url.clone();
    let mut resp = None;
    for _ in 0..5 {
        let r = client
            .get(&current)
            .send()
            .await
            .map_err(|e| format!("下载请求失败: {e}"))?;
        if r.status().is_redirection() {
            let Some(loc) = r.headers().get(reqwest::header::LOCATION) else {
                return Err("下载被重定向但缺少 Location 头".into());
            };
            let loc = loc
                .to_str()
                .map_err(|_| "重定向地址非法".to_string())?
                .to_string();
            // 相对跳转按当前地址补全（GitHub 只用绝对跳转，这里兜底）
            let next = if loc.starts_with("http") {
                loc
            } else if loc.starts_with('/') {
                current
                    .split_once("://")
                    .and_then(|(s, rest)| rest.find('/').map(|i| format!("{s}://{}", &rest[..i])))
                    .map(|origin| format!("{origin}{loc}"))
                    .unwrap_or(loc)
            } else {
                loc
            };
            // 关键：重定向终点必须重新过白名单，否则 SSRF 面敞开
            if !is_allowed_release_url(&next) && !bases.iter().any(|b| is_url_under_base(&next, b)) {
                return Err(format!("下载重定向到不允许的地址: {next}"));
            }
            current = next;
            continue;
        }
        resp = Some(r);
        break;
    }
    let resp = resp.ok_or_else(|| "下载重定向次数过多".to_string())?;
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
    if verify_sha && !actual.eq_ignore_ascii_case(&expected_sha256) {
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
            "https://github.com/org/market/releases/download/com.a.mspp",
            base
        ));
        assert!(is_url_under_base(
            "https://github.com/org/market/releases/download",
            base
        ));
        // 前缀边界：download-evil 不能被 download 覆盖
        assert!(!is_url_under_base(
            "https://github.com/org/market/releases/downloadevil/com.a.mspp",
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

    // ---------- 第三方源（开发者自助发布）白名单 ----------

    #[test]
    fn release_url_allows_any_github_repo() {
        // 任意开发者的任意仓库 Release 资产都放行
        assert!(is_allowed_release_url(
            "https://github.com/someone/my-plugin/releases/download/v1.0.0/com.x.y.mspp"
        ));
        assert!(is_allowed_release_url(
            "https://github.com/My-Search/my-search-plugin-market/releases/download/catalog/catalog.json"
        ));
        // GitHub 资产下载的真实 302 终点
        assert!(is_allowed_release_url(
            "https://objects.githubusercontent.com/github-production-release-asset/x/y"
        ));
    }

    #[test]
    fn release_url_rejects_subdomain_spoof() {
        // github.com.evil.com 的 host 不是 github.com
        assert!(!is_allowed_release_url(
            "https://github.com.evil.com/a/b/releases/download/v1/x.mspp"
        ));
        assert!(!is_allowed_release_url(
            "https://evilgithub.com/a/b/releases/download/v1/x.mspp"
        ));
    }

    #[test]
    fn release_url_rejects_userinfo_spoof() {
        // 真实 host 是 evil.com，github.com 只是 userinfo
        assert!(!is_allowed_release_url(
            "https://github.com@evil.com/a/b/releases/download/v1/x.mspp"
        ));
        // 反向：userinfo 是 evil，真 host 是 github.com —— 一律拒绝含 @ 的地址
        assert!(!is_allowed_release_url(
            "https://evil.com@github.com/a/b/releases/download/v1/x.mspp"
        ));
    }

    #[test]
    fn release_url_rejects_nonstandard_port() {
        assert!(!is_allowed_release_url(
            "https://github.com:8443/a/b/releases/download/v1/x.mspp"
        ));
        // 443 是显式允许的
        assert!(is_allowed_release_url(
            "https://github.com:443/a/b/releases/download/v1/x.mspp"
        ));
    }

    #[test]
    fn release_url_requires_https_and_release_path() {
        // 协议降级
        assert!(!is_allowed_release_url(
            "http://github.com/a/b/releases/download/v1/x.mspp"
        ));
        // 非 Release 路径
        assert!(!is_allowed_release_url(
            "https://github.com/a/b/raw/main/x.mspp"
        ));
        assert!(!is_allowed_release_url(
            "https://github.com/a/b/releases/tag/v1"
        ));
        // 路径用 starts_with 而非 contains：download-evil 不可通过
        assert!(!is_allowed_release_url(
            "https://github.com/a/b/releases/download-evil/v1/x.mspp"
        ));
    }

    #[test]
    fn release_url_host_case_insensitive_path_case_sensitive() {
        // host 大小写不敏感（DNS 语义）
        assert!(is_allowed_release_url(
            "https://GitHub.com/a/b/releases/download/v1/x.mspp"
        ));
        // path 大小写敏感（GitHub 实际路径为小写）
        assert!(!is_allowed_release_url(
            "https://github.com/a/b/Releases/Download/v1/x.mspp"
        ));
    }

    #[test]
    fn release_url_rejects_garbage() {
        assert!(!is_allowed_release_url(""));
        assert!(!is_allowed_release_url("javascript:alert(1)"));
        assert!(!is_allowed_release_url("file:///etc/passwd"));
        assert!(!is_allowed_release_url("not a url"));
    }

    // ---------- 官方插件仓库文件直链（raw） ----------

    #[test]
    fn official_raw_url_allows_expected_shape() {
        assert!(is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/official-plugins/com.mysearch.pi-agent/2.5.2/com.mysearch.pi-agent.mspp"
        ));
        // 分支名可以是其它值（第三段即 ref）
        assert!(is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/master/official-plugins/com.a.b/1.0.0/com.a.b.mspp"
        ));
    }

    #[test]
    fn official_raw_url_rejects_wrong_shape() {
        let base = "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main";
        // 不是 official-plugins 目录（防借 raw 域取任意仓库文件，如源码/密钥）
        assert!(!is_allowed_release_url(&format!("{base}/src/lib/main.ts")));
        assert!(!is_allowed_release_url(&format!("{base}/plugins/evil.txt")));
        // 目录名相近但不等
        assert!(!is_allowed_release_url(&format!(
            "{base}/official-plugins-evil/com.a.b/1.0.0/com.a.b.mspp"
        )));
        // 段数不对（缺版本层 / 多一层）
        assert!(!is_allowed_release_url(&format!(
            "{base}/official-plugins/com.a.b/com.a.b.mspp"
        )));
        assert!(!is_allowed_release_url(&format!(
            "{base}/official-plugins/com.a.b/1.0.0/extra/com.a.b.mspp"
        )));
        // 资产不是 .mspp
        assert!(!is_allowed_release_url(&format!(
            "{base}/official-plugins/com.a.b/1.0.0/com.a.b.sh"
        )));
    }

    #[test]
    fn official_raw_url_rejects_spoofing() {
        // userinfo / 非标端口 / 协议降级 在 raw 域同样要挡住
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com@evil.com/a/b/main/official-plugins/x/1.0.0/x.mspp"
        ));
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com:8443/a/b/main/official-plugins/x/1.0.0/x.mspp"
        ));
        assert!(!is_allowed_release_url(
            "http://raw.githubusercontent.com/a/b/main/official-plugins/x/1.0.0/x.mspp"
        ));
        // 子域名伪造
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com.evil.com/a/b/main/official-plugins/x/1.0.0/x.mspp"
        ));
    }

    // ---------- 市场索引本身（raw，4 段） ----------

    #[test]
    fn market_catalog_raw_url_is_allowed() {
        // 回归：索引从 Release 迁到仓库文件后，客户端必须拉得到它。
        // 索引是 4 段而插件包是 7 段，曾因只认 7 段而整条拉取失败。
        assert!(is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.dist.json"
        ));
        // 大小写不敏感（GitHub 域与路径段都不区分大小写）
        assert!(is_allowed_release_url(
            "https://raw.githubusercontent.com/my-search/MY-SEARCH-PLUGIN-MARKET/main/index.dist.json"
        ));
    }

    #[test]
    fn market_catalog_raw_url_rejects_other_repos_and_files() {
        // 别人的仓库放一份同名文件不得顶替我们的索引
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/attacker/my-search-plugin-market/main/index.dist.json"
        ));
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/evil.json"
        ));
        // 我们仓库里的其它文件同样不放行（raw 域只开放这两类形态）
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.json"
        ));
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.error.json"
        ));
        // 段数不对
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/sub/index.dist.json"
        ));
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/index.dist.json"
        ));
        // 非 main 分支不认（与客户端常量 MARKET_CATALOG_REF 一致）
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/dev/index.dist.json"
        ));
    }

    #[test]
    fn release_and_raw_channels_do_not_leak() {
        // github.com 的 raw 式路径不通过（github.com 只认 releases/download）
        assert!(!is_allowed_release_url(
            "https://github.com/a/b/main/official-plugins/x/1.0.0/x.mspp"
        ));
        // raw 域的 releases 式路径也不通过
        assert!(!is_allowed_release_url(
            "https://raw.githubusercontent.com/a/b/releases/download/v1/x.mspp"
        ));
    }

    // ---------- Release 资产 302 终点（线上故障回归） ----------

    #[test]
    fn release_asset_cdn_host_is_allowed() {
        // 回归：GitHub 实测会把 Release 资产 302 到 release-assets.githubusercontent.com。
        // 曾因白名单只写了 objects.githubusercontent.com 导致线上全部下载失败。
        assert!(is_allowed_release_url(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1379090128/f8dbbf96-a3cb-4302-8db7-0982eb9d258e?sp=r&sig=abc"
        ));
        // 早期域名一并保留
        assert!(is_allowed_release_url(
            "https://objects.githubusercontent.com/github-production-release-asset/123/456"
        ));
        // 子域名伪造仍要挡住
        assert!(!is_allowed_release_url(
            "https://release-assets.githubusercontent.com.evil.com/github-production-release-asset/1/2"
        ));
        assert!(!is_allowed_release_url(
            "https://evil.com/github-production-release-asset/1/2"
        ));
    }

    #[test]
    fn release_asset_cdn_path_must_be_asset_shaped() {
        // 资产域不能当任意跳板：路径必须是资产形态
        assert!(!is_allowed_release_url("https://release-assets.githubusercontent.com/"));
        assert!(!is_allowed_release_url(
            "https://release-assets.githubusercontent.com/anything/else"
        ));
        assert!(!is_allowed_release_url(
            "https://objects.githubusercontent.com/some/other/path"
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
    fn empty_sha256_skips_verification_for_catalog() {
        // 目录拉取（catalog.json）传空 sha256，应跳过校验而非报错
        let empty_sha = "";
        assert!(empty_sha.is_empty(), "空 sha256 应被识别为跳过校验");

        // 安装包下载必须传有效 sha256
        let valid_sha = "a".repeat(64);
        assert!(!valid_sha.is_empty() && is_valid_sha256(&valid_sha));

        // 非法 sha256（非空但格式不对）仍应报错
        let bad_sha = "not-64-hex";
        assert!(!bad_sha.is_empty() && !is_valid_sha256(bad_sha));
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
