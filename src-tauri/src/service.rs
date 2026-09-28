use crate::{
    models::{AccountUsage, Config, FailedAccount, LoginResult, UsageRefresh},
    store::{append_log, Store},
};
use chrono::Utc;
use reqwest::{header, Method, StatusCode};
use serde_json::{json, Value};
use std::sync::Arc;
use thiserror::Error;
use url::Url;

const ACCOUNT_PAGE_SIZE: usize = 100;

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("{message}")]
    Api {
        message: String,
        status: Option<u16>,
        code: Option<String>,
    },
    #[error("{0}")]
    Message(String),
}

impl ServiceError {
    fn unauthorized(&self) -> bool {
        matches!(
            self,
            Self::Api {
                status: Some(401),
                ..
            }
        ) || matches!(self, Self::Api { code: Some(code), .. } if code == "INVALID_ADMIN_KEY")
    }
}

pub type ServiceResult<T> = Result<T, ServiceError>;

pub struct UsageService {
    store: Arc<Store>,
    refresh_token_lock: tokio::sync::Mutex<()>,
}

impl UsageService {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            refresh_token_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn config(&self) -> Config {
        normalize_config(self.store.config())
    }

    pub fn set_config(&self, values: Value) -> ServiceResult<Config> {
        let previous = self.config();
        let mut merged = serde_json::to_value(self.config())
            .map_err(|error| ServiceError::Message(error.to_string()))?;
        if let (Some(target), Some(source)) = (merged.as_object_mut(), values.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        let mut config: Config = serde_json::from_value(merged)
            .map_err(|error| ServiceError::Message(format!("设置格式无效：{error}")))?;
        config = validate_config(config)?;
        let server_changed = server_origin(&previous.base_url) != server_origin(&config.base_url);
        self.store
            .set_config(config.clone(), server_changed)
            .map_err(ServiceError::Message)?;
        Ok(config)
    }

    pub fn auth_mode(&self) -> String {
        if self.store.secret("accessToken").is_empty() {
            "none".into()
        } else {
            "bearer".into()
        }
    }

    pub fn role(&self) -> String {
        let role = self.store.secret("role");
        if role.eq_ignore_ascii_case("admin") {
            "admin".into()
        } else if !role.is_empty() {
            "user".into()
        } else {
            String::new()
        }
    }

    pub async fn login(&self, email: &str, password: &str) -> ServiceResult<LoginResult> {
        if self.config().base_url.is_empty() {
            return Err(ServiceError::Message(
                "请先配置 Sub2API 服务器地址。".into(),
            ));
        }
        if email.trim().is_empty() || password.is_empty() {
            return Err(ServiceError::Message("邮箱和密码不能为空。".into()));
        }
        let auth = self
            .api_request(
                Method::POST,
                "/api/v1/auth/login",
                Some(json!({ "email": email.trim(), "password": password })),
                false,
            )
            .await?;
        if auth.get("requires_2fa").and_then(Value::as_bool) == Some(true) {
            let token = auth
                .get("temp_token")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ServiceError::Message("服务器要求 2FA，但没有返回临时令牌。".into())
                })?;
            return Ok(LoginResult {
                requires_2fa: true,
                temp_token: Some(token.into()),
                email: Some(email.trim().into()),
            });
        }
        self.save_jwt_auth(&auth, email.trim(), false)?;
        Ok(LoginResult {
            requires_2fa: false,
            temp_token: None,
            email: None,
        })
    }

    pub async fn complete_login(
        &self,
        temp_token: &str,
        totp_code: &str,
        email: &str,
    ) -> ServiceResult<LoginResult> {
        let code = totp_code.trim();
        if code.len() != 6 || !code.chars().all(|character| character.is_ascii_digit()) {
            return Err(ServiceError::Message("请输入 6 位数字验证码。".into()));
        }
        let auth = self
            .api_request(
                Method::POST,
                "/api/v1/auth/login/2fa",
                Some(json!({ "temp_token": temp_token, "totp_code": code })),
                false,
            )
            .await?;
        self.save_jwt_auth(&auth, email.trim(), false)?;
        Ok(LoginResult {
            requires_2fa: false,
            temp_token: None,
            email: None,
        })
    }

    pub async fn logout(&self) -> ServiceResult<()> {
        let refresh_token = self.store.secret("refreshToken");
        if !refresh_token.is_empty() {
            if let Err(error) = self
                .api_request(
                    Method::POST,
                    "/api/v1/auth/logout",
                    Some(json!({ "refresh_token": refresh_token })),
                    false,
                )
                .await
            {
                append_log(&format!("远程退出失败，本地凭据仍会清除：{error}"));
            }
        }
        self.store
            .clear_authentication()
            .map_err(ServiceError::Message)
    }

    pub async fn refresh_usage(&self) -> ServiceResult<UsageRefresh> {
        let config = self.config();
        if config.base_url.is_empty() {
            return Ok(empty_refresh(
                "needs-server",
                "请先配置 Sub2API 服务器地址。",
            ));
        }
        if self.auth_mode() == "none" {
            return Ok(empty_refresh("needs-auth", "请先登录你的账户。"));
        }

        if self.role() == "user" {
            return self.refresh_subscription_usage().await;
        }
        let all_accounts = self.list_accounts().await?;
        let active: Vec<Value> = all_accounts
            .iter()
            .filter(|account| {
                account
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_lowercase()
                    != "inactive"
            })
            .cloned()
            .collect();
        if active.is_empty() {
            return Ok(UsageRefresh {
                status: "empty".into(),
                accounts: Vec::new(),
                failed: Vec::new(),
                total_accounts: all_accounts.len(),
                refreshed_at: None,
                message: if all_accounts.is_empty() {
                    "没有找到账户。".into()
                } else {
                    "所有账户都处于停用状态。".into()
                },
            });
        }
        let queryable: Vec<Value> = active
            .into_iter()
            .filter(account_supports_batch_usage)
            .collect();
        if queryable.is_empty() {
            return Ok(UsageRefresh {
                status: "empty".into(),
                accounts: Vec::new(),
                failed: Vec::new(),
                total_accounts: all_accounts.len(),
                refreshed_at: None,
                message: "没有可查询用量的账户。".into(),
            });
        }

        let ids: Vec<Value> = queryable
            .iter()
            .filter_map(|account| account.get("id").cloned())
            .collect();
        let batch = self
            .api_request_with_retry(
                Method::POST,
                "/api/v1/admin/accounts/usage/batch",
                Some(json!({ "account_ids": ids, "force": true })),
            )
            .await?;
        let usages = batch.get("usage").and_then(Value::as_object);
        let errors = batch.get("errors").and_then(Value::as_object);
        let mut accounts = Vec::new();
        let mut failed = Vec::new();
        for account in queryable {
            let key = value_key(account.get("id"));
            if let Some(error) = errors.and_then(|items| items.get(&key)) {
                failed.push(FailedAccount {
                    account_name: account_display_name(&account),
                    error: value_message(error),
                });
                continue;
            }
            let usage = usages.and_then(|items| items.get(&key)).cloned();
            match usage.and_then(validate_usage) {
                Some(usage) => accounts.push(AccountUsage { account, usage }),
                None => failed.push(FailedAccount {
                    account_name: account_display_name(&account),
                    error: "批量接口未返回有效账户用量。".into(),
                }),
            }
        }
        Ok(UsageRefresh {
            status: if accounts.is_empty() {
                "error"
            } else {
                "ready"
            }
            .into(),
            message: if failed.is_empty() {
                String::new()
            } else {
                format!("{} 个账户刷新失败。", failed.len())
            },
            accounts,
            failed,
            total_accounts: all_accounts.len(),
            refreshed_at: Some(Utc::now().to_rfc3339()),
        })
    }

    async fn refresh_subscription_usage(&self) -> ServiceResult<UsageRefresh> {
        let subscriptions = self
            .api_request_with_retry(
                Method::GET,
                "/api/v1/subscriptions?timezone=Asia%2FShanghai",
                None,
            )
            .await?;
        let items = subscriptions.as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            return Ok(empty_refresh("empty", "当前账号没有任何订阅。"));
        }
        let mut accounts = Vec::new();
        for subscription in items {
            if let Some(usage) = subscription_usage(&subscription) {
                accounts.push(AccountUsage {
                    account: subscription.clone(),
                    usage,
                });
            }
        }
        if accounts.is_empty() {
            return Ok(empty_refresh("empty", "当前账号的订阅没有可用的用量额度。"));
        }
        Ok(UsageRefresh {
            status: "ready".into(),
            message: String::new(),
            total_accounts: accounts.len(),
            accounts,
            failed: Vec::new(),
            refreshed_at: Some(Utc::now().to_rfc3339()),
        })
    }

    async fn list_accounts(&self) -> ServiceResult<Vec<Value>> {
        self.list_accounts_using().await
    }

    async fn list_accounts_using(&self) -> ServiceResult<Vec<Value>> {
        let mut accounts = Vec::new();
        let mut page = 1usize;
        let mut pages = 1usize;
        while page <= pages && page <= 1000 {
            let path = format!(
                "/api/v1/admin/accounts?page={page}&page_size={ACCOUNT_PAGE_SIZE}&include_scheduler_score=0&sort_by=name&sort_order=asc&timezone=Asia%2FShanghai"
            );
            let data = self
                .api_request_with_retry(Method::GET, &path, None)
                .await?;
            let items = data
                .get("items")
                .and_then(Value::as_array)
                .or_else(|| data.as_array())
                .cloned()
                .unwrap_or_default();
            accounts.extend(items.into_iter().filter(|account| {
                account
                    .get("id")
                    .map(|value| value_key(Some(value)))
                    .is_some_and(|key| !key.trim().is_empty())
            }));
            pages = data
                .get("pages")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1) as usize;
            page += 1;
        }
        Ok(accounts)
    }

    async fn api_request_with_retry(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> ServiceResult<Value> {
        let failed_access_token = self.store.secret("accessToken");
        match self
            .api_request(method.clone(), path, body.clone(), true)
            .await
        {
            Ok(value) => Ok(value),
            Err(error) if error.unauthorized() && self.auth_mode() == "bearer" => {
                if !self.refresh_access_token(&failed_access_token).await {
                    return Err(ServiceError::Api {
                        message: "登录已过期，请重新登录。".into(),
                        status: Some(401),
                        code: None,
                    });
                }
                self.api_request(method, path, body, true).await
            }
            Err(error) => Err(error),
        }
    }

    async fn refresh_access_token(&self, failed_access_token: &str) -> bool {
        let _guard = self.refresh_token_lock.lock().await;
        let current_access_token = self.store.secret("accessToken");
        if !failed_access_token.is_empty() && current_access_token != failed_access_token {
            return !current_access_token.is_empty();
        }
        let refresh_token = self.store.secret("refreshToken");
        if refresh_token.is_empty() {
            return false;
        }
        match self
            .api_request(
                Method::POST,
                "/api/v1/auth/refresh",
                Some(json!({ "refresh_token": refresh_token })),
                false,
            )
            .await
        {
            Ok(auth) => self
                .save_jwt_auth(&auth, &self.store.secret("email"), true)
                .is_ok(),
            Err(error) => {
                append_log(&format!("刷新登录令牌失败：{error}"));
                let _ = self.store.delete_secrets(&["accessToken", "refreshToken"]);
                false
            }
        }
    }

    fn save_jwt_auth(
        &self,
        auth: &Value,
        email: &str,
        preserve_refresh_token: bool,
    ) -> ServiceResult<()> {
        let access_token = auth
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ServiceError::Message("登录响应中缺少 access_token。".into()))?;
        let existing_refresh_token =
            preserve_refresh_token.then(|| self.store.secret("refreshToken"));
        let refresh_token = auth
            .get("refresh_token")
            .and_then(Value::as_str)
            .or_else(|| {
                existing_refresh_token
                    .as_deref()
                    .filter(|value| !value.is_empty())
            });
        let role = auth
            .pointer("/user/role")
            .and_then(Value::as_str)
            .unwrap_or(self.store.secret("role").as_str())
            .to_string();
        self.store
            .replace_with_jwt(access_token, refresh_token, email, &role)
            .map_err(ServiceError::Message)
    }

    async fn api_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        auth: bool,
    ) -> ServiceResult<Value> {
        self.api_request_inner(method, path, body, auth).await
    }

    async fn api_request_inner(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        auth: bool,
    ) -> ServiceResult<Value> {
        let config = self.config();
        if config.base_url.is_empty() {
            return Err(ServiceError::Message(
                "尚未配置 Sub2API Server URL。".into(),
            ));
        }
        let base = format!("{}/", config.base_url.trim_end_matches('/'));
        let url = Url::parse(&base)
            .and_then(|base| base.join(path.trim_start_matches('/')))
            .map_err(|error| ServiceError::Message(format!("服务器地址无效：{error}")))?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(config.request_timeout))
            .danger_accept_invalid_certs(config.allow_insecure_tls)
            .build()
            .map_err(|error| ServiceError::Message(format!("创建网络客户端失败：{error}")))?;
        let mut request = client
            .request(method.clone(), url.clone())
            .header(header::ACCEPT, "application/json")
            .header(header::ACCEPT_LANGUAGE, "zh-CN")
            .header(
                header::USER_AGENT,
                concat!("sub2api-account-usage-tauri/", env!("CARGO_PKG_VERSION")),
            );
        if auth {
            let access_token = self.store.secret("accessToken");
            if !access_token.is_empty() {
                request = request.bearer_auth(access_token);
            } else {
                return Err(ServiceError::Api {
                    message: "尚未登录。".into(),
                    status: Some(401),
                    code: None,
                });
            }
            request = request.header("X-Admin-UI-Request", "1");
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        append_log(&format!(
            "{} {} [{}]",
            method,
            url.path(),
            if auth { "auth" } else { "no-auth" }
        ));
        let response = request.send().await.map_err(|error| {
            ServiceError::Message(if error.is_timeout() {
                format!("请求超时（{}ms）", config.request_timeout)
            } else {
                format!("网络请求失败：{error}")
            })
        })?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ServiceError::Message(format!("读取服务器响应失败：{error}")))?;
        let raw: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| ServiceError::Api {
                message: format!("HTTP {}：服务器返回的不是 JSON", status.as_u16()),
                status: Some(status.as_u16()),
                code: None,
            })?
        };
        if !status.is_success() {
            return Err(api_error(status, &raw));
        }
        unwrap_api_response(raw)
    }
}

fn normalize_config(mut config: Config) -> Config {
    config.base_url = config.base_url.trim().trim_end_matches('/').to_string();
    config.update_interval = config.update_interval.max(30);
    config.rotation_interval = config.rotation_interval.max(1);
    config.request_timeout = config.request_timeout.max(1000);
    config
}

fn validate_config(mut config: Config) -> ServiceResult<Config> {
    config = normalize_config(config);
    if !config.base_url.is_empty() {
        let url = Url::parse(&config.base_url)
            .map_err(|_| ServiceError::Message("服务器地址无效。".into()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ServiceError::Message(
                "服务器地址只支持 http 或 https。".into(),
            ));
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ServiceError::Message(
                "服务器地址不能包含账号、密码、查询参数或片段。".into(),
            ));
        }
        if url.path() != "/" && !url.path().is_empty() {
            return Err(ServiceError::Message(
                "服务器地址只能填写根地址，不要带 /api/v1 或其他路径。".into(),
            ));
        }
        config.base_url = url.as_str().trim_end_matches('/').to_string();
    }
    Ok(config)
}

fn server_origin(value: &str) -> Option<(String, String, Option<u16>)> {
    let url = Url::parse(value).ok()?;
    Some((
        url.scheme().to_ascii_lowercase(),
        url.host_str()?.to_ascii_lowercase(),
        url.port_or_known_default(),
    ))
}

fn empty_refresh(status: &str, message: &str) -> UsageRefresh {
    UsageRefresh {
        status: status.into(),
        accounts: Vec::new(),
        failed: Vec::new(),
        total_accounts: 0,
        refreshed_at: None,
        message: message.into(),
    }
}

fn unwrap_api_response(raw: Value) -> ServiceResult<Value> {
    if let Some(code) = raw.get("code") {
        let successful = code.as_i64() == Some(0) || code.as_str() == Some("0");
        if !successful {
            return Err(ServiceError::Api {
                message: server_message(&raw).unwrap_or_else(|| format!("API error code {code}")),
                status: None,
                code: code.as_str().map(str::to_string),
            });
        }
        return Ok(raw.get("data").cloned().unwrap_or(Value::Null));
    }
    Ok(raw)
}

fn api_error(status: StatusCode, value: &Value) -> ServiceError {
    ServiceError::Api {
        message: server_message(value).unwrap_or_else(|| format!("HTTP {}", status.as_u16())),
        status: Some(status.as_u16()),
        code: value
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn server_message(value: &Value) -> Option<String> {
    ["message", "detail", "error"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str).map(str::to_string))
        .or_else(|| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn account_supports_batch_usage(account: &Value) -> bool {
    let platform = account
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let kind = account
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    match platform.as_str() {
        "anthropic" => matches!(kind.as_str(), "oauth" | "setup-token"),
        "gemini" => true,
        "antigravity" | "openai" | "grok" => kind == "oauth",
        _ => false,
    }
}

fn validate_usage(usage: Value) -> Option<Value> {
    let five = number(usage.pointer("/five_hour/utilization"))?;
    let seven = number(usage.pointer("/seven_day/utilization"))?;
    (five.is_finite() && seven.is_finite()).then_some(usage)
}

fn subscription_usage(subscription: &Value) -> Option<Value> {
    let weekly = subscription_breakdown(subscription, "weekly");
    let monthly = subscription_breakdown(subscription, "monthly");
    (weekly.is_some() || monthly.is_some()).then(|| {
        json!({
            "weekly": weekly,
            "monthly": monthly,
        })
    })
}

fn subscription_breakdown(subscription: &Value, window: &str) -> Option<Value> {
    let used_key = format!("{window}_usage_usd");
    let limit_key = format!("{window}_limit_usd");
    let limit_path = format!("/group/{limit_key}");
    let used = number(subscription.get(&used_key)).unwrap_or(0.0);
    let limit = number(subscription.pointer(&limit_path)).unwrap_or(0.0);
    let utilization = if limit > 0.0 {
        used * 100.0 / limit
    } else {
        0.0
    };
    Some(json!({
        "utilization": utilization,
        "usageUsd": used,
        "limitUsd": limit,
    }))
}

pub fn account_display_name(account: &Value) -> String {
    account
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            account
                .get("group")
                .and_then(|group| group.get("name"))
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
        })
        .unwrap_or("未命名")
        .to_string()
}

fn value_key(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(value) => value.to_string().trim_matches('"').to_string(),
        None => String::new(),
    }
}

fn value_message(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        account_supports_batch_usage, server_origin, subscription_breakdown, validate_usage,
    };
    use serde_json::json;

    #[test]
    fn usage_accepts_numeric_strings() {
        let usage = json!({
            "five_hour": { "utilization": "35.5" },
            "seven_day": { "utilization": 72 }
        });
        assert!(validate_usage(usage).is_some());
    }

    #[test]
    fn subscription_breakdown_reads_limits_from_group() {
        let subscription = json!({
            "weekly_usage_usd": 30,
            "monthly_usage_usd": 120,
            "group": {
                "weekly_limit_usd": 600,
                "monthly_limit_usd": 2400
            }
        });
        let weekly = subscription_breakdown(&subscription, "weekly").unwrap();
        assert_eq!(weekly["usageUsd"], 30.0);
        assert_eq!(weekly["limitUsd"], 600.0);
        assert!((weekly["utilization"].as_f64().unwrap() - 5.0).abs() < 1e-9);
        let monthly = subscription_breakdown(&subscription, "monthly").unwrap();
        assert_eq!(monthly["usageUsd"], 120.0);
        assert_eq!(monthly["limitUsd"], 2400.0);
        assert!((monthly["utilization"].as_f64().unwrap() - 5.0).abs() < 1e-9);
    }

    #[test]
    fn account_platform_rules_match_server_support() {
        assert!(account_supports_batch_usage(
            &json!({ "platform": "openai", "type": "oauth" })
        ));
        assert!(!account_supports_batch_usage(
            &json!({ "platform": "openai", "type": "key" })
        ));
        assert!(account_supports_batch_usage(
            &json!({ "platform": "gemini", "type": "key" })
        ));
    }

    #[test]
    fn server_origin_ignores_trailing_slashes_but_not_ports() {
        assert_eq!(
            server_origin("https://example.com"),
            server_origin("https://EXAMPLE.com/")
        );
        assert_ne!(
            server_origin("https://example.com"),
            server_origin("https://example.com:8443")
        );
    }
}
