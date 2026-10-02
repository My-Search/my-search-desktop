//! 规则驱动的 HTTP 代理
//!
//! 与 `system_proxy` 的区别与关系：
//! - `system_proxy` 负责**读**系统/环境变量里的代理地址（原样保留，不在此模块里改）；
//! - 本模块负责**决定哪些请求才走代理**——只有目标主机命中规则时才注入代理，
//!   未命中的一律直连。这样代理不再「全局生效」，避免把本地/内网请求也推进代理。
//!
//! 规则来源（两者取并集）：
//! 1. **规则列表**（`ProxySettings::rules`）：默认预置 `github.com` /
//!    `githubusercontent.com`，是一份**可编辑的文本清单**（一行一条，见前端面板），
//!    面板里直接编辑即可增删（想恢复预置可点「恢复默认」，用 `DEFAULT_RULES`）；
//! 2. **规则库**：默认预置 gfwlist（`DEFAULT_GFWLIST_URL`），后台按间隔定时拉取、
//!    解析、缓存到本地（支持 gfwlist 的 base64 文本与常见 ABP 语法），并入规则集。
//!
//! 总开关语义：
//! - 关闭：任何请求都直连（即使命中规则）；
//! - 开启：仅命中规则的请求走代理；系统未配置代理时命中规则也只能直连。
//!
//! 实现要点：reqwest 0.12 的 `Proxy::all/http/https` 只能按协议选择、无法表达
//! 「按主机白名单」；唯一能按目标主机决定是否走代理的是 `reqwest::Proxy::custom`，
//! 它在每个连接（含重定向后的新主机）用真实目标 URL 求值。故这里用 custom 闭包，
//! 命中规则才返回代理地址，否则返回 `None`（直连）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::system_proxy;

/// 默认规则列表：首次运行预置、「恢复默认」也用它。命中即走代理，保证 GitHub 可达。
/// 这是一份**可被用户编辑**的文本清单（一行一条），编辑后即以用户内容为准。
pub(crate) const DEFAULT_RULES: &[&str] = &["github.com", "githubusercontent.com"];

/// 默认规则库地址：gfwlist（base64 文本，解析后并入规则集）。
pub(crate) const DEFAULT_GFWLIST_URL: &str =
    "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt";

/// settings.json 里存整套代理配置的键名（一个对象键，参见 `shortcut_bindings`）。
pub(crate) const SETTINGS_KEY_PROXY: &str = "proxy_settings";

/// 规则库缓存文件名（存于应用数据目录，与 settings.json 分离，避免撑大设置存储）。
const RULES_CACHE_FILE: &str = "proxy-rules.json";
/// 缓存文件结构版本号（便于日后迁移）。
const RULES_SCHEMA_VERSION: u32 = 1;

/// 代理配置结构版本号。0/缺省 = 早期版本（无 schema_version），读取时做一次迁移
/// （补上默认 gfwlist 规则库），保证老用户升级后也能「默认就有 gfwlist」。
pub(crate) const PROXY_SCHEMA_VERSION: u32 = 1;

/// 后台刷新线程的检查节拍（秒）。每小时检查一次是否到期，开销可忽略。
const REFRESH_CHECK_SECS: u64 = 3600;
/// 规则库更新间隔的默认值（小时）。
pub(crate) const DEFAULT_INTERVAL_HOURS: u32 = 24;
/// 更新间隔允许范围（小时）。
const MIN_INTERVAL_HOURS: u32 = 1;
const MAX_INTERVAL_HOURS: u32 = 24 * 30;

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===================== 配置模型 =====================

/// 单个规则库来源。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RuleSource {
    /// 规则库地址（纯文本域名单，或 gfwlist 的 base64 文本）。
    pub url: String,
    /// 是否启用（禁用后不参与拉取，但保留配置）。
    pub enabled: bool,
}

impl Default for RuleSource {
    fn default() -> Self {
        Self {
            url: String::new(),
            enabled: true,
        }
    }
}

/// 用户在「高级设置 → 代理」里维护的全部配置（持久化在 settings.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ProxySettings {
    /// 代理功能总开关（默认开启）。关闭时即使命中规则也不走代理。
    pub enabled: bool,
    /// 规则列表（一行一条，命中走代理）。首次运行预置 `DEFAULT_RULES`，
    /// 之后以用户编辑内容为准（可点「恢复默认」重置为 `DEFAULT_RULES`）。
    /// 兼容旧键名 `manualRules`。
    #[serde(alias = "manualRules")]
    pub rules: Vec<String>,
    /// 规则库来源列表（默认含 gfwlist）。
    pub rule_sources: Vec<RuleSource>,
    /// 规则库自动更新间隔（小时）。
    pub update_interval_hours: u32,
    /// 上次成功更新规则的 Unix 毫秒时间戳（0 = 从未更新）。
    pub last_updated_ms: i64,
    /// 上次成功更新后规则库贡献的规则条数（供面板展示）。
    pub library_rule_count: usize,
    /// 配置结构版本号（用于升级迁移；老配置缺省为 0）。
    #[serde(default)]
    pub schema_version: u32,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            rules: DEFAULT_RULES.iter().map(|s| s.to_string()).collect(),
            rule_sources: vec![RuleSource {
                url: DEFAULT_GFWLIST_URL.to_string(),
                enabled: true,
            }],
            update_interval_hours: DEFAULT_INTERVAL_HOURS,
            last_updated_ms: 0,
            library_rule_count: 0,
            schema_version: PROXY_SCHEMA_VERSION,
        }
    }
}

impl ProxySettings {
    /// 归一化：裁剪空白、丢弃空地址/空规则、把间隔夹到合法区间。
    fn sanitized(mut self) -> Self {
        self.rules = normalize_rule_list(self.rules);
        self.rule_sources = self
            .rule_sources
            .into_iter()
            .filter_map(|s| {
                let url = s.url.trim();
                if url.is_empty() {
                    return None;
                }
                Some(RuleSource {
                    url: url.to_string(),
                    enabled: s.enabled,
                })
            })
            .collect();
        self.update_interval_hours = self
            .update_interval_hours
            .clamp(MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS);
        if self.last_updated_ms < 0 {
            self.last_updated_ms = 0;
        }
        self
    }

    /// 升级迁移：把老版本配置补齐到当前结构。
    ///
    /// v0 → v1：早期版本没有默认 gfwlist，规则库列表为空。这里给**规则库为空**
    /// 的老配置补上默认 gfwlist（用户已自行配置过规则库的则原样尊重，不覆盖）。
    fn migrated(mut self) -> Self {
        if self.schema_version < PROXY_SCHEMA_VERSION {
            if self.rule_sources.is_empty() {
                self.rule_sources.push(RuleSource {
                    url: DEFAULT_GFWLIST_URL.to_string(),
                    enabled: true,
                });
            }
            self.schema_version = PROXY_SCHEMA_VERSION;
        }
        self
    }
}

/// 返回给前端的代理总览：默认规则（供「恢复默认」）+ 当前系统代理状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyInfo {
    /// 默认规则清单（「恢复默认」用）。
    pub default_rules: Vec<String>,
    /// 系统/环境变量里当前是否读到代理。
    pub system_proxy_configured: bool,
    /// 系统 HTTP 代理地址（若有）。
    pub system_http: Option<String>,
    /// 系统 HTTPS 代理地址（若有）。
    pub system_https: Option<String>,
}

/// 「立即更新规则库」的返回结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuleUpdateResult {
    /// 是否至少有一个来源成功并刷新了缓存。
    pub updated: bool,
    /// 刷新后规则库贡献的规则条数。
    pub rule_count: usize,
    /// 各来源的错误信息（部分失败仍可能整体成功）。
    pub errors: Vec<String>,
}

// ===================== 内存中的生效规则 =====================

/// 编译后的规则集（每次配置变更后整体替换）。
#[derive(Debug, Default)]
struct ActiveConfig {
    /// 总开关。关闭时不做任何主机匹配。
    enabled: bool,
    /// 精确域名集合（含各级父域，匹配时按标签逐级上溯）。
    exact: HashSet<String>,
    /// 是否命中全部主机（规则里出现 `*`）。
    wildcard_all: bool,
    /// 系统绕过名单（命中则强制直连）。
    bypass: Vec<String>,
}

impl ActiveConfig {
    /// 主机是否应走代理。
    fn matches(&self, host: &str) -> bool {
        if !self.enabled || (self.exact.is_empty() && !self.wildcard_all) {
            return false;
        }
        if self.is_bypassed(host) {
            return false;
        }
        if self.wildcard_all {
            return true;
        }
        let h = normalize_host(host);
        if h.is_empty() {
            return false;
        }
        // 从完整主机逐级去掉最左标签（api.github.com → github.com → com），
        // 任一级命中精确集合即视为命中。
        let mut cur = h.as_str();
        loop {
            if self.exact.contains(cur) {
                return true;
            }
            match cur.find('.') {
                Some(i) => cur = &cur[i + 1..],
                None => return false,
            }
        }
    }

    /// 是否命中系统绕过名单（强制直连）。
    fn is_bypassed(&self, host: &str) -> bool {
        let h = normalize_host(host);
        if h.is_empty() {
            return false;
        }
        self.bypass.iter().any(|rule| host_matches_rule(rule, &h))
    }
}

/// 全局生效规则。`None` = 尚未初始化（setup 前），此时按默认配置即时编译。
static ACTIVE: RwLock<Option<Arc<ActiveConfig>>> = RwLock::new(None);

/// 取当前生效规则；未初始化时用默认配置即时编译（仅发生在启动早期）。
fn active() -> Arc<ActiveConfig> {
    if let Ok(guard) = ACTIVE.read() {
        if let Some(cfg) = guard.as_ref() {
            return cfg.clone();
        }
    }
    Arc::new(compile(&ProxySettings::default(), &[]))
}

/// 用最新配置重建生效规则（配置变更 / 启动时调用）。
pub(crate) fn refresh(app: &AppHandle) {
    let settings = read_settings(app).sanitized();
    let library = load_cached_rules(app);
    let compiled = Arc::new(compile(&settings, &library));
    if let Ok(mut guard) = ACTIVE.write() {
        *guard = Some(compiled);
    }
}

/// 由配置 + 规则库规则编译出匹配集。
fn compile(settings: &ProxySettings, library: &[String]) -> ActiveConfig {
    let mut exact = HashSet::new();
    let mut wildcard_all = false;

    let rules = settings.rules.iter().cloned();
    let lib = library.iter().cloned();
    for raw in rules.chain(lib) {
        match normalize_rule(&raw) {
            // `*`：命中全部主机
            Some(d) if d == "*" => wildcard_all = true,
            Some(d) if !d.is_empty() => {
                exact.insert(d);
            }
            _ => {}
        }
    }

    let bypass = system_proxy::read_system_proxy()
        .and_then(|c| c.no_proxy)
        .map(|s| parse_rule_text(&s))
        .unwrap_or_default();

    ActiveConfig {
        enabled: settings.enabled,
        exact,
        wildcard_all,
        bypass,
    }
}

// ===================== 注入 reqwest =====================

/// 把「规则驱动的代理」注入 reqwest builder。
///
/// - 总开关关闭 → 显式直连（`no_proxy()`，同时关掉 reqwest 自身的系统代理探测，
///   避免环境变量代理「绕过」我们的开关偷偷生效）；
/// - 开启但无规则 / 系统未配置代理 → 同样直连（命中规则也没有代理可用）；
/// - 开启且有系统代理 → 注册一个 `Proxy::custom`，仅命中规则的目标主机走代理。
///
/// 每次构建 Client 都重新读取（配置在内存、系统代理现场读），因此开关 / 规则 /
/// 系统代理的改动都能即时生效，无需重启。
pub(crate) fn apply_proxy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let cfg = active();

    // 关闭 / 无规则 / 无系统代理 → 一律直连，并关掉 reqwest 的自动系统代理。
    let Some(sys) = system_proxy::read_system_proxy() else {
        return builder.no_proxy();
    };
    if !cfg.enabled || (cfg.exact.is_empty() && !cfg.wildcard_all) {
        return builder.no_proxy();
    }
    let (http, https) = (sys.http, sys.https);
    if http.is_none() && https.is_none() {
        return builder.no_proxy();
    }

    let rules = cfg.clone();
    let proxy = reqwest::Proxy::custom(move |url| {
        let host = url.host_str().unwrap_or("");
        if !rules.matches(host) {
            return None;
        }
        let raw = match url.scheme() {
            "http" => http.as_ref().or(https.as_ref()),
            _ => https.as_ref().or(http.as_ref()),
        }?;
        reqwest::Url::parse(raw).ok()
    });

    builder.proxy(proxy)
}

// ===================== 设置读写 =====================

/// 读取代理设置（未写入过时返回默认：开启 + 默认规则 + gfwlist）。
pub(crate) fn read_settings(app: &AppHandle) -> ProxySettings {
    crate::settings_store(app)
        .and_then(|store| store.get(SETTINGS_KEY_PROXY))
        .and_then(|v| serde_json::from_value::<ProxySettings>(v).ok())
        .map(|s| s.migrated().sanitized())
        .unwrap_or_default()
}

/// 写入代理设置（store 不可用时静默跳过：本次已生效，重启后回落默认）。
pub(crate) fn write_settings(app: &AppHandle, settings: &ProxySettings) {
    if let Some(store) = crate::settings_store(app) {
        if let Ok(v) = serde_json::to_value(settings) {
            store.set(SETTINGS_KEY_PROXY, v);
            if let Err(e) = store.save() {
                eprintln!("保存代理设置失败: {e}");
            }
        }
    }
}

/// 供前端展示的代理总览。
pub(crate) fn proxy_info() -> ProxyInfo {
    let sys = system_proxy::read_system_proxy();
    ProxyInfo {
        default_rules: DEFAULT_RULES.iter().map(|s| s.to_string()).collect(),
        system_proxy_configured: sys.is_some(),
        system_http: sys.as_ref().and_then(|c| c.http.clone()),
        system_https: sys.as_ref().and_then(|c| c.https.clone()),
    }
}

// ===================== 规则库缓存 =====================

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RulesCache {
    schema_version: u32,
    updated_at_ms: i64,
    rules: Vec<String>,
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建目录失败: {e}")))?;
    Ok(dir.join(RULES_CACHE_FILE))
}

/// 读取本地缓存的规则库规则（缓存缺失/损坏时返回空，不影响内置与自定义规则）。
fn load_cached_rules(app: &AppHandle) -> Vec<String> {
    cache_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<RulesCache>(&t).ok())
        .map(|c| c.rules)
        .unwrap_or_default()
}

fn save_cached_rules(app: &AppHandle, rules: &[String], updated_at_ms: i64) -> Result<(), String> {
    let cache = RulesCache {
        schema_version: RULES_SCHEMA_VERSION,
        updated_at_ms,
        rules: rules.to_vec(),
    };
    let path = cache_path(app)?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?,
    )
    .map_err(|e| err(format!("写入规则缓存失败: {e}")))
}

// ===================== 规则库拉取与更新 =====================

/// 从单个规则库地址拉取文本（对 raw.githubusercontent.com 先试 jsDelivr，国内可达）。
async fn fetch_source(url: &str) -> Result<String, String> {
    let client = crate::build_client(20, crate::UA)?;
    let mut candidates: Vec<String> = Vec::new();
    if let Some(cdn) = crate::convert_raw_to_jsdelivr(url) {
        candidates.push(cdn);
    }
    candidates.push(url.to_string());

    let mut last_err = String::new();
    for u in candidates {
        match client.get(&u).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(t) if !t.trim().is_empty() => return Ok(t),
                Ok(_) => last_err = format!("{u}: 内容为空"),
                Err(e) => last_err = format!("{u}: 读取响应失败 {e}"),
            },
            Ok(resp) => last_err = format!("{u}: HTTP {}", resp.status().as_u16()),
            Err(e) => last_err = format!("{u}: 请求失败 {e}"),
        }
    }
    Err(last_err)
}

/// 立即拉取所有启用的规则库并刷新缓存与生效规则。
///
/// 只要有一个来源成功即视为更新成功（部分失败通过 `errors` 上报）；
/// 全部失败时**保留旧缓存**，避免把可用规则清空。
pub(crate) async fn update_rules_now(app: &AppHandle) -> RuleUpdateResult {
    let mut settings = read_settings(app);
    let mut errors: Vec<String> = Vec::new();
    let mut fetched: Vec<String> = Vec::new();
    let mut any_ok = false;
    let mut enabled_count = 0usize;

    let sources: Vec<RuleSource> = settings.rule_sources.clone();
    for src in sources.iter().filter(|s| s.enabled) {
        enabled_count += 1;
        match fetch_source(&src.url).await {
            Ok(text) => {
                any_ok = true;
                fetched.extend(parse_rule_text(&text));
            }
            Err(e) => errors.push(format!("{} → {e}", src.url)),
        }
    }

    if enabled_count == 0 {
        return RuleUpdateResult {
            updated: false,
            rule_count: settings.library_rule_count,
            errors: vec!["未配置规则库地址".into()],
        };
    }
    if !any_ok {
        return RuleUpdateResult {
            updated: false,
            rule_count: settings.library_rule_count,
            errors,
        };
    }

    let rules = normalize_rule_list(fetched);
    let now = now_ms();
    if let Err(e) = save_cached_rules(app, &rules, now) {
        errors.push(e);
    }
    settings.last_updated_ms = now;
    settings.library_rule_count = rules.len();
    write_settings(app, &settings);
    refresh(app);

    RuleUpdateResult {
        updated: true,
        rule_count: rules.len(),
        errors,
    }
}

/// 后台自动更新线程的停止通道。
static REFRESH_STOP: Mutex<Option<Sender<()>>> = Mutex::new(None);

/// 判断当前是否到了该自动更新的时刻。
fn due_for_update(app: &AppHandle) -> bool {
    let settings = read_settings(app);
    if !settings.enabled || !settings.rule_sources.iter().any(|s| s.enabled) {
        return false;
    }
    let interval_ms = settings.update_interval_hours.max(1) as i64 * 3600 * 1000;
    now_ms().saturating_sub(settings.last_updated_ms) >= interval_ms
}

/// 启动规则库定时更新线程（只启动一次；退出时用 `stop_auto_refresh` 关闭）。
pub(crate) fn start_auto_refresh(app: AppHandle) {
    let mut guard = match REFRESH_STOP.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_some() {
        return;
    }
    let (tx, rx) = channel::<()>();
    *guard = Some(tx);
    drop(guard);

    let spawned = std::thread::Builder::new()
        .name("proxy-rules-refresh".into())
        .spawn(move || refresh_loop(app, rx));
    if let Err(e) = spawned {
        eprintln!("启动规则库定时更新线程失败: {e}");
        if let Ok(mut guard) = REFRESH_STOP.lock() {
            *guard = None;
        }
    }
}

fn refresh_loop(app: AppHandle, rx: Receiver<()>) {
    loop {
        match rx.recv_timeout(Duration::from_secs(REFRESH_CHECK_SECS)) {
            // 收到停止信号：退出
            Ok(()) => break,
            // 超时：检查是否到期
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if !due_for_update(&app) {
            continue;
        }
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = update_rules_now(&handle).await;
        });
    }
}

/// 关闭定时更新线程（应用退出时调用）。
pub(crate) fn stop_auto_refresh() {
    if let Ok(mut guard) = REFRESH_STOP.lock() {
        *guard = None;
    }
}

// ===================== 纯解析与匹配辅助 =====================

/// 归一化主机名：小写、去空白、去尾部点、去端口。
fn normalize_host(host: &str) -> String {
    let h = host.trim().to_ascii_lowercase();
    let h = h.trim_end_matches('.');
    // 去端口（IPv6 带方括号的场景不处理，代理规则里极罕见）
    match h.rfind(':') {
        Some(i) if !h.contains(']') => h[..i].to_string(),
        _ => h.to_string(),
    }
}

/// 归一化单条规则为「域名」形态；`*` 原样返回；无法识别返回 None。
fn normalize_rule(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if s.is_empty() || s.starts_with('#') || s.starts_with('!') || s.starts_with('[') {
        return None;
    }
    // 白名单例外语法（gfwlist 的 @@）不参与代理
    if s.starts_with("@@") {
        return None;
    }
    // ABP：||domain^ / |http://domain
    s = s.trim_start_matches('|');
    if s.is_empty() {
        return None;
    }
    // 去协议
    if let Some(rest) = s.split_once("://").map(|(_, r)| r) {
        s = rest;
    }
    // 去 userinfo
    if let Some(rest) = s.split_once('@').map(|(_, r)| r) {
        s = rest;
    }
    // 取到第一个路径/锚点/通配之前的宿主部分
    let end = s
        .find(|c| matches!(c, '/' | '^' | '?' | '#'))
        .unwrap_or(s.len());
    s = &s[..end];
    let s = s.trim();
    if s == "*" {
        return Some("*".into());
    }
    // 去前导 *. 或 .
    let s = s.trim_start_matches("*.").trim_start_matches('.');
    let s = normalize_host(s);
    if s.is_empty() {
        return None;
    }
    // 必须是「看起来像域名/主机」的串：允许字母数字、点、连字符、下划线；
    // gfwlist 里也可能有纯 IP。
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return None;
    }
    Some(s)
}

/// 判断主机是否命中单条规则（规则已归一化为域名；支持 `*` 全匹配与 `*.x` 前缀）。
fn host_matches_rule(rule: &str, host: &str) -> bool {
    let rule = rule.trim().trim_start_matches("*.").trim_start_matches('.');
    if rule.is_empty() {
        return false;
    }
    if rule == "*" {
        return true;
    }
    if let Some(prefix) = rule.strip_suffix(".*") {
        // 形如 `127.*`：按前缀匹配
        return host == prefix || host.starts_with(&format!("{prefix}."));
    }
    host == rule || host.ends_with(&format!(".{rule}"))
}

/// 归一化一组规则：去重、去空、保序。
fn normalize_rule_list(raw: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in raw {
        if let Some(d) = normalize_rule(&item) {
            if d.is_empty() {
                continue;
            }
            if seen.insert(d.clone()) {
                out.push(d);
            }
        }
    }
    out
}

/// 解析规则库文本为规则列表。
///
/// - 自动识别 base64（gfwlist 原格式）并解码；
/// - 支持每行一个域名，`#`/`!`/`[` 开头视为注释；
/// - 兼容常见 ABP 语法：`||domain^`、`|http://domain/path`、`*.domain`、`@@`（跳过）。
pub(crate) fn parse_rule_text(text: &str) -> Vec<String> {
    let decoded = decode_if_base64(text);
    let mut out = Vec::new();
    for line in decoded.lines() {
        if let Some(d) = normalize_rule(line) {
            out.push(d);
        }
    }
    normalize_rule_list(out)
}

/// 若文本整体是 base64（gfwlist 常见），解码后返回；否则原样返回。
fn decode_if_base64(text: &str) -> String {
    let t = text.trim();
    if t.len() < 32
        || !t
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '\n' | '\r' | ' '))
    {
        return text.to_string();
    }
    let cleaned: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    use base64::Engine;
    match base64::engine::general_purpose::STANDARD.decode(cleaned) {
        Ok(bytes) => match String::from_utf8(bytes) {
            // 解码结果至少要像规则文本（含换行或域名点），否则可能误判
            Ok(s) if s.contains('\n') || s.contains('.') => s,
            _ => text.to_string(),
        },
        Err(_) => text.to_string(),
    }
}

// ===================== 测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn compiled(rules: &[&str]) -> ActiveConfig {
        let settings = ProxySettings {
            enabled: true,
            rules: rules.iter().map(|s| s.to_string()).collect(),
            rule_sources: Vec::new(),
            ..Default::default()
        };
        compile(&settings, &[])
    }

    #[test]
    fn rule_matches_domain_and_subdomains() {
        let cfg = compiled(&["github.com"]);
        assert!(cfg.matches("github.com"));
        assert!(cfg.matches("api.github.com"));
        assert!(cfg.matches("a.b.github.com"));
        assert!(!cfg.matches("github.com.evil.com"));
        assert!(!cfg.matches("example.com"));
    }

    #[test]
    fn default_rules_include_github() {
        // 默认配置的规则里预置了 github，命中域名与其子域
        let cfg = compile(&ProxySettings::default(), &[]);
        assert!(cfg.matches("github.com"));
        assert!(cfg.matches("raw.githubusercontent.com"));
    }

    #[test]
    fn default_settings_prefill_gfwlist_source() {
        let d = ProxySettings::default();
        assert!(d.rule_sources.iter().any(|s| s.url == DEFAULT_GFWLIST_URL));
    }

    #[test]
    fn migration_adds_gfwlist_when_sources_empty() {
        // 模拟老配置（无 schemaVersion、规则库为空）
        let json = serde_json::json!({
            "enabled": true,
            "rules": ["github.com"],
            "ruleSources": [],
        });
        let old: ProxySettings = serde_json::from_value(json).unwrap();
        let migrated = old.migrated();
        assert_eq!(migrated.schema_version, PROXY_SCHEMA_VERSION);
        assert!(migrated.rule_sources.iter().any(|s| s.url == DEFAULT_GFWLIST_URL));

        // 用户已自配规则库时，迁移不覆盖
        let json2 = serde_json::json!({
            "ruleSources": [{ "url": "https://example.com/list.txt", "enabled": true }],
        });
        let old2: ProxySettings = serde_json::from_value(json2).unwrap();
        let m2 = old2.migrated();
        assert_eq!(m2.rule_sources.len(), 1);
        assert_eq!(m2.rule_sources[0].url, "https://example.com/list.txt");
    }

    #[test]
    fn legacy_manual_rules_key_still_reads() {
        // 旧版本存的是 manualRules 键，读取时仍能拿到
        let json = serde_json::json!({ "manualRules": ["legacy.com"] });
        let s: ProxySettings = serde_json::from_value(json).unwrap();
        assert_eq!(s.rules, vec!["legacy.com".to_string()]);
    }

    #[test]
    fn wildcard_matches_everything() {
        let cfg = compiled(&["*"]);
        assert!(cfg.matches("anything.example"));
        assert!(cfg.matches("127.0.0.1"));
    }

    #[test]
    fn disabled_switch_never_matches() {
        let settings = ProxySettings {
            enabled: false,
            rules: vec!["github.com".into()],
            rule_sources: Vec::new(),
            ..Default::default()
        };
        let cfg = compile(&settings, &[]);
        assert!(!cfg.matches("github.com"));
    }

    #[test]
    fn rule_normalization_forms() {
        assert_eq!(normalize_rule("https://GitHub.com/path").as_deref(), Some("github.com"));
        assert_eq!(normalize_rule("||example.com^").as_deref(), Some("example.com"));
        assert_eq!(normalize_rule("|http://foo.bar/baz").as_deref(), Some("foo.bar"));
        assert_eq!(normalize_rule("*.cdn.example").as_deref(), Some("cdn.example"));
        assert_eq!(normalize_rule("example.com:8080").as_deref(), Some("example.com"));
        assert_eq!(normalize_rule("*").as_deref(), Some("*"));
        assert_eq!(normalize_rule("! comment"), None);
        assert_eq!(normalize_rule("@@||whitelist.com^"), None);
        assert_eq!(normalize_rule(""), None);
    }

    #[test]
    fn parse_plain_text_rules() {
        let text = "# gfwlist\ngithub.com\n||pinterest.com^\n\n! note\n|http://x.y/z\n";
        let rules = parse_rule_text(text);
        assert!(rules.contains(&"github.com".to_string()));
        assert!(rules.contains(&"pinterest.com".to_string()));
        assert!(rules.contains(&"x.y".to_string()));
        assert!(!rules.iter().any(|r| r.contains('#')));
    }

    #[test]
    fn parse_base64_rules() {
        use base64::Engine;
        let raw = "||github.com^\n||twitter.com^\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        let rules = parse_rule_text(&encoded);
        assert!(rules.contains(&"github.com".to_string()));
        assert!(rules.contains(&"twitter.com".to_string()));
    }

    #[test]
    fn host_matches_rule_prefix_wildcard() {
        assert!(host_matches_rule("127.*", "127.0.0.1"));
        assert!(!host_matches_rule("127.*", "128.0.0.1"));
        assert!(host_matches_rule("github.com", "api.github.com"));
    }

    #[test]
    fn rule_list_dedupes_and_orders() {
        let list = normalize_rule_list(vec![
            "github.com".into(),
            "GitHub.com".into(),
            "||github.com^".into(),
            "example.com".into(),
        ]);
        assert_eq!(list, vec!["github.com".to_string(), "example.com".to_string()]);
    }

    #[test]
    fn sanitize_clamps_interval_and_drops_empty_sources() {
        let s = ProxySettings {
            update_interval_hours: 0,
            rule_sources: vec![
                RuleSource { url: "  ".into(), enabled: true },
                RuleSource { url: " https://a/b ".into(), enabled: true },
            ],
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.update_interval_hours, MIN_INTERVAL_HOURS);
        assert_eq!(s.rule_sources.len(), 1);
        assert_eq!(s.rule_sources[0].url, "https://a/b");
    }
}
