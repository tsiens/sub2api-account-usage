use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const DEFAULT_UPDATE_URL: &str = "https://github.com/tsiens/sub2api-account-usage";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub base_url: String,
    pub update_url: String,
    pub update_interval: u64,
    pub rotation_interval: u64,
    pub request_timeout: u64,
    pub allow_insecure_tls: bool,
    pub show_floating_bar: bool,
    pub float_always_on_top: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            update_url: DEFAULT_UPDATE_URL.to_string(),
            update_interval: 300,
            rotation_interval: 5,
            request_timeout: 15_000,
            allow_insecure_tls: false,
            show_floating_bar: true,
            float_always_on_top: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FloatPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StoreData {
    pub config: Config,
    pub secrets: BTreeMap<String, String>,
    pub float_position: Option<FloatPosition>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub account: Value,
    pub usage: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedAccount {
    pub account_name: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicState {
    pub status: String,
    pub accounts: Vec<AccountUsage>,
    pub failed: Vec<FailedAccount>,
    pub message: String,
    pub refreshed_at: Option<String>,
    pub is_refreshing: bool,
    pub auth_mode: String,
    pub current_index: usize,
    pub total_accounts: usize,
    pub config: Config,
}

#[derive(Clone, Debug)]
pub struct UsageRefresh {
    pub status: String,
    pub accounts: Vec<AccountUsage>,
    pub failed: Vec<FailedAccount>,
    pub total_accounts: usize,
    pub refreshed_at: Option<String>,
    pub message: String,
}

impl PublicState {
    pub fn initial(config: Config) -> Self {
        Self {
            status: "needs-server".into(),
            accounts: Vec::new(),
            failed: Vec::new(),
            message: "请配置 Sub2API 服务器地址。".into(),
            refreshed_at: None,
            is_refreshing: false,
            auth_mode: "none".into(),
            current_index: 0,
            total_accounts: 0,
            config,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub email: String,
    pub password: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteLoginInput {
    pub temp_token: String,
    pub totp_code: String,
    pub email: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub requires_2fa: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsPoint {
    pub label: String,
    pub date: String,
    pub requests: f64,
    pub tokens: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStats {
    pub history: Vec<StatsPoint>,
    pub total_requests: f64,
    pub total_tokens: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUiState {
    pub status: String,
    pub version: String,
    pub percent: f64,
    pub transferred: u64,
    pub total: u64,
    pub speed: u64,
    pub message: String,
}

impl Default for UpdateUiState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            version: String::new(),
            percent: 0.0,
            transferred: 0,
            total: 0,
            speed: 0,
            message: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct MoveDelta {
    pub dx: f64,
    pub dy: f64,
}

#[derive(Clone, Debug)]
pub struct AvailableUpdate {
    pub version: String,
    pub download_url: String,
    pub sha256: String,
}
