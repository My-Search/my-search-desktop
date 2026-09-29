//! 跟随系统代理（跨平台，全部手写 + 原生 API）
//!
//! 目标：软件/插件与浏览器行为一致——系统开了代理就走代理，系统关了代理就
//! 自动回到直连；三平台（Windows / macOS / Linux）一致；**每次构建 Client 时
//! 现场重新读取**，所以代理开关（如 Clash 的「系统代理」）切换后无需重启应用。
//!
//! 为什么手写而不用 reqwest 的 `system-proxy` 特性：
//! 1. reqwest 的自动逻辑是「环境变量优先、系统设置补空位」，与本项目要求的
//!    「**系统代理优先**」相反；
//! 2. reqwest 在 Linux 上只读环境变量，不读 GNOME 图形化系统代理。
//! 因此三平台读取逻辑由本模块自己实现（`#[cfg]` 分平台），再手动注入
//! `reqwest::Proxy`。注意：一旦显式调用 `.proxy(...)`，reqwest 会自动关闭它
//! 自己的系统代理探测，这正合我们意（避免两套逻辑叠加）。
//!
//! 各平台来源：
//! - Windows：注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
//!   的 `ProxyEnable` / `ProxyServer` / `ProxyOverride`（Clash「系统代理」写此处）
//! - macOS：SystemConfiguration 的 `SCDynamicStoreCopyProxies`
//! - Linux：GNOME `gsettings org.gnome.system.proxy`（`mode=manual` 才启用）
//!
//! 已知边界：仅支持「手动指定 host:port」的系统代理。PAC 模式（Windows
//! `AutoConfigURL` / gsettings `mode=auto`）需要 JS 引擎，本模块不支持；
//! Clash 的 TUN 模式不写系统代理（由虚拟网卡接管），不受影响。

use reqwest::ClientBuilder;

/// 从系统（+ 环境变量补空位）读到的代理配置。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ProxyConfig {
    /// HTTP 代理地址，形如 `http://127.0.0.1:7890`
    pub http: Option<String>,
    /// HTTPS 代理地址
    pub https: Option<String>,
    /// 绕过名单，已归一化为逗号分隔（reqwest `NoProxy::from_string` 的格式）
    pub no_proxy: Option<String>,
}

/// 读取当前生效的代理配置；无代理返回 `None`（调用方据此走直连）。
///
/// 每次调用都现场读系统设置，不做缓存——这是「代理开关即时生效」的前提。
pub(crate) fn read_system_proxy() -> Option<ProxyConfig> {
    merge_proxy(platform_proxy(), &read_env_proxy())
}

/// 把系统代理注入 reqwest builder。无代理则原样返回（走直连）。
///
/// 任何一步失败（地址非法等）都静默跳过，绝不因代理配置让请求报错。
pub(crate) fn apply_system_proxy(builder: ClientBuilder) -> ClientBuilder {
    let Some(cfg) = read_system_proxy() else {
        return builder;
    };

    let mut builder = builder;
    let no_proxy = cfg.no_proxy.as_deref().and_then(reqwest::NoProxy::from_string);

    if let Some(url) = cfg.http.as_deref() {
        if let Ok(p) = reqwest::Proxy::http(url) {
            builder = builder.proxy(with_no_proxy(p, no_proxy.clone()));
        }
    }
    if let Some(url) = cfg.https.as_deref() {
        if let Ok(p) = reqwest::Proxy::https(url) {
            builder = builder.proxy(with_no_proxy(p, no_proxy.clone()));
        }
    }

    builder
}

fn with_no_proxy(p: reqwest::Proxy, no_proxy: Option<reqwest::NoProxy>) -> reqwest::Proxy {
    match no_proxy {
        Some(n) => p.no_proxy(Some(n)),
        None => p,
    }
}

// ===================== 环境变量（补空位） =====================

#[derive(Debug, Default)]
struct EnvProxy {
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    no_proxy: Option<String>,
}

fn read_env_proxy() -> EnvProxy {
    EnvProxy {
        http: env_first(&["HTTP_PROXY", "http_proxy"]),
        https: env_first(&["HTTPS_PROXY", "https_proxy"]),
        all: env_first(&["ALL_PROXY", "all_proxy"]),
        no_proxy: env_first(&["NO_PROXY", "no_proxy"]),
    }
}

fn env_first(names: &[&str]) -> Option<String> {
    for name in names {
        if let Ok(v) = std::env::var(name) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// 合并系统代理与环境变量：**系统代理优先**，环境变量仅补空位。
///
/// - http  = 系统.http  → HTTP_PROXY → ALL_PROXY
/// - https = 系统.https → HTTPS_PROXY → ALL_PROXY
/// - no_proxy = 系统绕过名单 + NO_PROXY（拼接）
///
/// http/https 都为空时返回 `None`。
fn merge_proxy(sys: ProxyConfig, env: &EnvProxy) -> Option<ProxyConfig> {
    let http = sys
        .http
        .or_else(|| env.http.clone())
        .or_else(|| env.all.clone())
        .map(|s| ensure_scheme(&s));
    let https = sys
        .https
        .or_else(|| env.https.clone())
        .or_else(|| env.all.clone())
        .map(|s| ensure_scheme(&s));
    let no_proxy = merge_no_proxy(
        sys.no_proxy.map(|s| normalize_no_proxy(&s)),
        env.no_proxy.clone().map(|s| normalize_no_proxy(&s)),
    );

    if http.is_none() && https.is_none() {
        return None;
    }
    Some(ProxyConfig {
        http,
        https,
        no_proxy,
    })
}

// ===================== 纯解析辅助 =====================

/// 补全代理地址的 scheme：reqwest 要求带 scheme 的 URL，
/// 而系统设置里常是裸的 `127.0.0.1:7890`，默认按 http 处理。
fn ensure_scheme(raw: &str) -> String {
    let s = raw.trim();
    if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    }
}

/// 归一化绕过名单为逗号分隔：兼容 `;` 与 `,` 两种分隔，
/// 去掉 `<local>` 占位与 `*.` 通配前缀（reqwest 的域名匹配已含子域）。
fn normalize_no_proxy(raw: &str) -> String {
    raw.split([';', ','])
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("<local>"))
        .map(|s| s.strip_prefix("*.").unwrap_or(s).to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn merge_no_proxy(a: Option<String>, b: Option<String>) -> Option<String> {
    let parts: Vec<String> = [a, b]
        .into_iter()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// 解析 Windows 的 `ProxyServer`：既支持单一 `host:port`（http/https 同用），
/// 也支持分协议 `http=host:port;https=host:port` 形式。
#[cfg(any(windows, test))]
fn parse_win_proxy_server(server: &str) -> (Option<String>, Option<String>) {
    let server = server.trim();
    if server.is_empty() {
        return (None, None);
    }
    if server.contains('=') {
        let mut http = None;
        let mut https = None;
        for part in server.split(';') {
            let Some((k, v)) = part.split_once('=') else {
                continue;
            };
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            match k.trim().to_ascii_lowercase().as_str() {
                "http" => http = Some(ensure_scheme(v)),
                "https" => https = Some(ensure_scheme(v)),
                _ => {}
            }
        }
        (http, https)
    } else {
        let v = ensure_scheme(server);
        (Some(v.clone()), Some(v))
    }
}

// ===================== 各平台读取 =====================

#[cfg(windows)]
fn platform_proxy() -> ProxyConfig {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        KEY_READ,
    ) else {
        return ProxyConfig::default();
    };

    if key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 0 {
        return ProxyConfig::default();
    }

    let server = key.get_value::<String, _>("ProxyServer").unwrap_or_default();
    let (http, https) = parse_win_proxy_server(&server);
    // 原始 ProxyOverride（分号分隔、含 `*.`/`<local>`），归一化统一在 merge_proxy 做。
    let no_proxy = key
        .get_value::<String, _>("ProxyOverride")
        .ok()
        .filter(|s| !s.trim().is_empty());

    ProxyConfig {
        http,
        https,
        no_proxy,
    }
}

#[cfg(target_os = "macos")]
fn platform_proxy() -> ProxyConfig {
    mac::platform_proxy()
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{ensure_scheme, ProxyConfig};
    use system_configuration::core_foundation::array::CFArray;
    use system_configuration::core_foundation::base::{CFType, TCFType};
    use system_configuration::core_foundation::dictionary::CFDictionary;
    use system_configuration::core_foundation::number::CFNumber;
    use system_configuration::core_foundation::string::{CFString, CFStringRef};
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;
    use system_configuration::sys::schema_definitions::{
        kSCPropNetProxiesExceptionsList, kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPPort,
        kSCPropNetProxiesHTTPProxy, kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSPort,
        kSCPropNetProxiesHTTPSProxy,
    };

    pub(super) fn platform_proxy() -> ProxyConfig {
        let Some(store) = SCDynamicStoreBuilder::new("my-search-desktop").build() else {
            return ProxyConfig::default();
        };
        let Some(map) = store.get_proxies() else {
            return ProxyConfig::default();
        };

        let http = read(
            &map,
            unsafe { kSCPropNetProxiesHTTPEnable },
            unsafe { kSCPropNetProxiesHTTPProxy },
            unsafe { kSCPropNetProxiesHTTPPort },
        );
        let https = read(
            &map,
            unsafe { kSCPropNetProxiesHTTPSEnable },
            unsafe { kSCPropNetProxiesHTTPSProxy },
            unsafe { kSCPropNetProxiesHTTPSPort },
        );
        let no_proxy = exceptions(&map);

        ProxyConfig {
            http,
            https,
            no_proxy,
        }
    }

    /// 读单个协议（http/https）的 `{Enable,Proxy,Port}` 三元组。
    fn read(
        map: &CFDictionary<CFString, CFType>,
        enable: CFStringRef,
        host: CFStringRef,
        port: CFStringRef,
    ) -> Option<String> {
        let enabled = map
            .find(enable)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i32())
            .unwrap_or(0)
            == 1;
        if !enabled {
            return None;
        }

        let host = map
            .find(host)
            .and_then(|v| v.downcast::<CFString>())
            .map(|h| h.to_string())?;
        if host.is_empty() {
            return None;
        }

        let port = map
            .find(port)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i32());

        Some(match port {
            Some(p) => ensure_scheme(&format!("{host}:{p}")),
            None => ensure_scheme(&host),
        })
    }

    /// 读 `ExceptionsList`（绕过名单），归一化为逗号分隔。
    fn exceptions(map: &CFDictionary<CFString, CFType>) -> Option<String> {
        let arr = map
            .find(unsafe { kSCPropNetProxiesExceptionsList })?
            .downcast::<CFArray>()?;
        let mut parts: Vec<String> = Vec::new();
        for ptr in arr.iter() {
            let raw: CFStringRef = *ptr as CFStringRef;
            let s = unsafe { CFString::wrap_under_get_rule(raw) }.to_string();
            if !s.trim().is_empty() {
                parts.push(s);
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(","))
        }
    }
}

#[cfg(target_os = "linux")]
fn platform_proxy() -> ProxyConfig {
    // 非 GNOME 桌面或未安装 gsettings 时，各 get 调用返回 None，静默回退环境变量。
    if gsettings_get("org.gnome.system.proxy", "mode").as_deref() != Some("manual") {
        return ProxyConfig::default();
    }

    let http = gsettings_proxy("org.gnome.system.proxy.http");
    let https = gsettings_proxy("org.gnome.system.proxy.https");
    let no_proxy = gsettings_get("org.gnome.system.proxy", "ignore-hosts")
        .map(|s| parse_gsettings_array(&s))
        .filter(|s| !s.is_empty());

    ProxyConfig {
        http,
        https,
        no_proxy,
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_proxy() -> ProxyConfig {
    ProxyConfig::default()
}

#[cfg(target_os = "linux")]
fn gsettings_get(schema: &str, key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(unquote_gsettings(&raw))
}

#[cfg(target_os = "linux")]
fn gsettings_proxy(schema: &str) -> Option<String> {
    let host = gsettings_get(schema, "host")?;
    if host.is_empty() {
        return None;
    }
    let addr = match gsettings_get(schema, "port") {
        Some(p) if !p.is_empty() => format!("{host}:{p}"),
        _ => host,
    };
    Some(ensure_scheme(&addr))
}

/// 去掉 gsettings 字符串值的单引号包裹（如 `'127.0.0.1'` → `127.0.0.1`）。
/// 纯字符串函数，`test` 下也编译，便于在任意平台单测。
#[cfg(any(target_os = "linux", test))]
fn unquote_gsettings(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// 解析 gsettings 数组值（如 `['localhost', '127.0.0.0/8']`）为逗号分隔。
#[cfg(any(target_os = "linux", test))]
fn parse_gsettings_array(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| unquote_gsettings(s.trim()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

// ===================== 测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_scheme_adds_http_when_missing() {
        assert_eq!(ensure_scheme("127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(ensure_scheme(" 127.0.0.1:7890 "), "http://127.0.0.1:7890");
        assert_eq!(ensure_scheme("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
        assert_eq!(ensure_scheme("http://a:1"), "http://a:1");
    }

    #[test]
    fn normalize_no_proxy_handles_both_separators_and_wildcards() {
        assert_eq!(
            normalize_no_proxy("localhost;127.*;*.example.com;<local>"),
            "localhost,127.*,example.com"
        );
        assert_eq!(normalize_no_proxy("a.com, b.com ,"), "a.com,b.com");
        assert_eq!(normalize_no_proxy(""), "");
    }

    #[test]
    fn merge_no_proxy_joins_non_empty() {
        assert_eq!(merge_no_proxy(None, None), None);
        assert_eq!(merge_no_proxy(Some("a".into()), None), Some("a".into()));
        assert_eq!(
            merge_no_proxy(Some("a".into()), Some("b".into())),
            Some("a,b".into())
        );
        assert_eq!(merge_no_proxy(Some("  ".into()), None), None);
    }

    #[test]
    fn merge_proxy_system_takes_priority_over_env() {
        let sys = ProxyConfig {
            http: Some("http://sys-http:1".into()),
            https: Some("http://sys-https:2".into()),
            no_proxy: Some("local".into()),
        };
        let env = EnvProxy {
            http: Some("http://env-http:9".into()),
            https: Some("http://env-https:9".into()),
            all: Some("http://env-all:9".into()),
            no_proxy: Some("extra".into()),
        };
        let merged = merge_proxy(sys, &env).unwrap();
        assert_eq!(merged.http.as_deref(), Some("http://sys-http:1"));
        assert_eq!(merged.https.as_deref(), Some("http://sys-https:2"));
        assert_eq!(merged.no_proxy.as_deref(), Some("local,extra"));
    }

    #[test]
    fn merge_proxy_env_fills_missing_and_all_fallback() {
        let sys = ProxyConfig {
            http: Some("http://sys-http:1".into()),
            https: None,
            no_proxy: None,
        };
        let env = EnvProxy {
            http: Some("http://env-http:9".into()),
            https: None,
            all: Some("http://env-all:9".into()),
            no_proxy: None,
        };
        let merged = merge_proxy(sys, &env).unwrap();
        // 系统 http 优先；https 系统缺失 → ALL_PROXY 兜底
        assert_eq!(merged.http.as_deref(), Some("http://sys-http:1"));
        assert_eq!(merged.https.as_deref(), Some("http://env-all:9"));
    }

    #[test]
    fn merge_proxy_none_when_no_proxy_anywhere() {
        assert!(merge_proxy(ProxyConfig::default(), &EnvProxy::default()).is_none());
    }

    #[cfg(any(windows, test))]
    #[test]
    fn parse_win_proxy_server_single_and_protocol_forms() {        assert_eq!(
            parse_win_proxy_server("127.0.0.1:7890"),
            (
                Some("http://127.0.0.1:7890".into()),
                Some("http://127.0.0.1:7890".into())
            )
        );
        assert_eq!(
            parse_win_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891"),
            (
                Some("http://127.0.0.1:7890".into()),
                Some("http://127.0.0.1:7891".into())
            )
        );
        assert_eq!(parse_win_proxy_server(""), (None, None));
    }

    #[test]
    fn parse_gsettings_array_strips_quotes() {
        assert_eq!(
            parse_gsettings_array("['localhost', '127.0.0.0/8', '::1']"),
            "localhost,127.0.0.0/8,::1"
        );
        assert_eq!(parse_gsettings_array("[]"), "");
    }

    #[test]
    fn unquote_gsettings_only_strips_surrounding_quotes() {
        assert_eq!(unquote_gsettings("'manual'"), "manual");
        assert_eq!(unquote_gsettings("7890"), "7890");
    }
}
