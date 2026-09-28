use serde::Deserialize;

use crate::status::ProviderStatus;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ProviderOverview {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub detail: String,
    pub fix: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Activity {
    Active,
    Degraded,
    Inactive,
    Unknown,
}

impl Activity {
    pub fn label(self) -> &'static str {
        match self {
            Activity::Active => "Active",
            Activity::Degraded => "Degraded",
            Activity::Inactive => "Inactive",
            Activity::Unknown => "Not checked",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderAction {
    OpenSite(String),
    CaptureQwen,
    AddApiKey,
    RunInTerminal(String),
}

pub fn parse_overview(output: &str) -> Result<Vec<ProviderOverview>, String> {
    let start = output.find('[').ok_or_else(|| "Unexpected accounts output".to_string())?;
    serde_json::from_str(&output[start..]).map_err(|error| format!("Unexpected accounts output: {error}"))
}

pub fn activity(overview: &ProviderOverview, live: Option<&ProviderStatus>) -> Activity {
    if live.is_some_and(|live| !live.available) {
        return Activity::Inactive;
    }
    match overview.state.as_str() {
        "connected" => Activity::Active,
        "degraded" => Activity::Degraded,
        "not-connected" => Activity::Inactive,
        _ if live.is_some_and(|live| live.available) && overview.kind == "web" => Activity::Active,
        _ => Activity::Unknown,
    }
}

pub fn detail(overview: &ProviderOverview, live: Option<&ProviderStatus>) -> String {
    match live {
        Some(ProviderStatus { available: false, reason: Some(reason), .. }) => reason.clone(),
        _ => overview.detail.clone(),
    }
}

pub fn action(overview: &ProviderOverview) -> Option<ProviderAction> {
    let fix = overview.fix.as_deref()?;
    if let Some(url) = fix.strip_prefix("bun run account open ") {
        return Some(ProviderAction::OpenSite(url.trim().to_string()));
    }
    if fix.starts_with("bun run account add qwen --browser") {
        return Some(ProviderAction::CaptureQwen);
    }
    if fix.starts_with("bun run account add nvidia --api-key") {
        return Some(ProviderAction::AddApiKey);
    }
    if fix == "bun run account status" {
        return None;
    }
    Some(ProviderAction::RunInTerminal(fix.to_string()))
}

pub fn display_name(id: &str) -> &str {
    match id {
        "qwen" => "Qwen",
        "deepseek" => "DeepSeek",
        "glm-chat" => "GLM (Z.ai)",
        "kimi-chat" => "Kimi",
        "nvidia" => "NVIDIA",
        other => other,
    }
}

pub fn kind_label(kind: &str) -> &str {
    match kind {
        "web" => "Web chat",
        "api-key" => "API key",
        "account" => "Web chat",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, kind: &str, state: &str, fix: Option<&str>) -> ProviderOverview {
        ProviderOverview { id: id.into(), kind: kind.into(), state: state.into(), detail: "d".into(), fix: fix.map(Into::into) }
    }

    fn live(available: bool, reason: Option<&str>) -> ProviderStatus {
        ProviderStatus { id: "x".into(), available, reason: reason.map(Into::into) }
    }

    #[test]
    fn parses_cli_json_after_the_script_banner() {
        let output = "$ bun run scripts/accounts.ts --json\n[{\"id\":\"nvidia\",\"kind\":\"api-key\",\"state\":\"connected\",\"detail\":\"API key (environment)\"}]";
        assert_eq!(parse_overview(output).unwrap(), vec![ProviderOverview {
            id: "nvidia".into(),
            kind: "api-key".into(),
            state: "connected".into(),
            detail: "API key (environment)".into(),
            fix: None,
        }]);
        assert!(parse_overview("no json").is_err());
    }

    #[test]
    fn live_gateway_health_overrides_saved_state() {
        let connected = row("glm-chat", "web", "connected", None);
        assert_eq!(activity(&connected, None), Activity::Active);
        assert_eq!(activity(&connected, Some(&live(false, Some("expired")))), Activity::Inactive);
        assert_eq!(detail(&connected, Some(&live(false, Some("expired")))), "expired");
        let unknown = row("kimi-chat", "web", "unknown", Some("bun run account status"));
        assert_eq!(activity(&unknown, None), Activity::Unknown);
        assert_eq!(activity(&unknown, Some(&live(true, None))), Activity::Active);
        assert_eq!(activity(&row("qwen", "account", "degraded", None), None), Activity::Degraded);
        assert_eq!(activity(&row("nvidia", "api-key", "not-connected", None), None), Activity::Inactive);
    }

    #[test]
    fn maps_fix_commands_to_actions() {
        assert_eq!(action(&row("kimi-chat", "web", "not-connected", Some("bun run account open https://www.kimi.ai/"))), Some(ProviderAction::OpenSite("https://www.kimi.ai/".into())));
        assert_eq!(action(&row("qwen", "account", "not-connected", Some("bun run account add qwen --browser"))), Some(ProviderAction::CaptureQwen));
        assert_eq!(action(&row("nvidia", "api-key", "not-connected", Some("bun run account add nvidia --api-key"))), Some(ProviderAction::AddApiKey));
        assert_eq!(action(&row("deepseek", "account", "not-connected", Some("bun run auth:deepseek"))), Some(ProviderAction::RunInTerminal("bun run auth:deepseek".into())));
        assert_eq!(action(&row("glm-chat", "web", "unknown", Some("bun run account status"))), None);
        assert_eq!(action(&row("nvidia", "api-key", "connected", None)), None);
    }
}
