use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct GatewayStatus {
    pub providers: Vec<ProviderStatus>,
    pub accounts: Vec<AccountStatus>,
    pub requests: Vec<RequestLog>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderStatus {
    pub id: String,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub account_id: String,
    pub provider: String,
    pub status: String,
    pub consecutive_failures: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub created_at: i64,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub latency_ms: Option<i64>,
    pub error: Option<String>,
}

pub fn fetch_status(base_url: &str, api_key: Option<&str>) -> Result<GatewayStatus, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .build()
        .into();
    let mut request = agent.get(format!("{base_url}/v1/gateway/status"));
    if let Some(key) = api_key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    request
        .call()
        .map_err(|error| error.to_string())?
        .body_mut()
        .read_json::<GatewayStatus>()
        .map_err(|error| error.to_string())
}

pub fn api_key_from(env_value: Option<String>, dotenv: &str) -> Option<String> {
    env_value.filter(|value| !value.is_empty()).or_else(|| {
        dotenv
            .lines()
            .filter_map(|line| line.trim().strip_prefix("GATEWAY_API_KEY="))
            .map(|value| value.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            .rfind(|value| !value.is_empty())
    })
}

pub fn read_api_key(root: &Path) -> Option<String> {
    let dotenv = std::fs::read_to_string(root.join(".env")).unwrap_or_default();
    api_key_from(std::env::var("GATEWAY_API_KEY").ok(), &dotenv)
}

pub fn relative_time(created_at_ms: i64, now_ms: i64) -> String {
    let seconds = ((now_ms - created_at_ms) / 1000).max(0);
    match seconds {
        0..=59 => format!("{seconds}s ago"),
        60..=3599 => format!("{}m ago", seconds / 60),
        3600..=86_399 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_gateway_status_payload() {
        let status: GatewayStatus = serde_json::from_str(r#"{
            "providers": [{"id": "qwen", "ownedBy": "qwen-api", "available": false, "reason": "QWEN_TOKEN is not set"}],
            "accounts": [{"accountId": "qwen-1", "provider": "qwen", "status": "cooldown", "consecutiveFailures": 2,
                "cooldownUntil": 1, "quotaResetAt": null, "lastUsedAt": null, "lastSuccessAt": null, "lastErrorAt": null, "lastError": "x"}],
            "requests": [{"createdAt": 1000, "provider": "deepseek", "model": "deepseek-default", "accountId": null,
                "status": "success", "latencyMs": 812, "error": null}]
        }"#).unwrap();
        assert_eq!(status.providers[0].reason.as_deref(), Some("QWEN_TOKEN is not set"));
        assert_eq!(status.accounts[0].consecutive_failures, 2);
        assert_eq!(status.requests[0].latency_ms, Some(812));
    }

    #[test]
    fn prefers_the_environment_api_key_over_dotenv() {
        let dotenv = "ZENMUX_API_KEY=x\nGATEWAY_API_KEY=\"from-file\"\n";
        assert_eq!(api_key_from(Some("from-env".into()), dotenv).as_deref(), Some("from-env"));
        assert_eq!(api_key_from(Some(String::new()), dotenv).as_deref(), Some("from-file"));
        assert_eq!(api_key_from(None, "GATEWAY_API_KEY=\n"), None);
    }

    #[test]
    fn formats_relative_times() {
        assert_eq!(relative_time(0, 5_000), "5s ago");
        assert_eq!(relative_time(0, 125_000), "2m ago");
        assert_eq!(relative_time(0, 7_200_000), "2h ago");
        assert_eq!(relative_time(0, 172_800_000), "2d ago");
        assert_eq!(relative_time(10_000, 0), "0s ago");
    }
}
