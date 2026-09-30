use serde::Deserialize;

use crate::status::ProviderStatus;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ProviderOverview {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub detail: String,
    pub fix: Option<String>,
    #[serde(default = "enabled")]
    pub auto: bool,
    pub url: Option<String>,
}

fn enabled() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Activity {
    Active,
    Degraded,
    Inactive,
    Unknown,
    NotConnected,
}

impl Activity {
    pub fn label(self) -> &'static str {
        match self {
            Activity::Active => "Active",
            Activity::Degraded => "Degraded",
            Activity::Inactive => "Inactive",
            Activity::Unknown => "Not checked",
            Activity::NotConnected => "Not connected",
        }
    }
}

pub fn parse_overview(output: &str) -> Result<Vec<ProviderOverview>, String> {
    let start = output.find('[').ok_or_else(|| "Unexpected accounts output".to_string())?;
    serde_json::from_str(&output[start..]).map_err(|error| format!("Unexpected accounts output: {error}"))
}

pub fn activity(overview: &ProviderOverview, live: Option<&ProviderStatus>) -> Activity {
    if overview.kind == "api-key" && overview.state == "not-connected" {
        return Activity::NotConnected;
    }
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

pub fn display_name(id: &str) -> &str {
    match id {
        "qwen" | "qwen-chat" => "Qwen Chat",
        "deepseek" => "DeepSeek Chat",
        "glm-chat" => "GLM Chat",
        "kimi-chat" => "Kimi Chat",
        "arena-chat" => "Arena Chat",
        "nvidia" => "NVIDIA",
        "openrouter" => "OpenRouter",
        "groq" => "Groq",
        "gemini" => "Google Gemini",
        "cerebras" => "Cerebras",
        "mistral" => "Mistral",
        "sambanova" => "SambaNova",
        "github-models" => "GitHub Models",
        "huggingface" => "Hugging Face",
        "bigmodel" => "Zhipu BigModel",
        "cohere" => "Cohere",
        "aion" => "Aion Labs",
        "ovhcloud" => "OVHcloud AI",
        "llm7" => "LLM7.io",
        "zai" => "Z.AI",
        "ollama-cloud" => "Ollama Cloud",
        "opencode-zen" => "OpenCode Zen",
        "kilo" => "Kilo Gateway",
        other => other,
    }
}

pub fn kind_label(kind: &str) -> &str {
    match kind {
        "web" | "account" => "Chat",
        "api-key" => "API key",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, kind: &str, state: &str, fix: Option<&str>) -> ProviderOverview {
        ProviderOverview { id: id.into(), kind: kind.into(), state: state.into(), detail: "d".into(), fix: fix.map(Into::into), auto: true, url: None }
    }

    fn live(available: bool, reason: Option<&str>) -> ProviderStatus {
        ProviderStatus { id: "x".into(), available, reason: reason.map(Into::into) }
    }

    #[test]
    fn parses_cli_json_after_the_script_banner() {
        let output = "$ bun run scripts/accounts.ts --json\n[{\"id\":\"nvidia\",\"kind\":\"api-key\",\"state\":\"connected\",\"detail\":\"API key (environment)\",\"auto\":false},{\"id\":\"glm-chat\",\"kind\":\"web\",\"state\":\"unknown\",\"detail\":\"d\",\"url\":\"https://chat.z.ai/\"}]";
        let rows = parse_overview(output).unwrap();
        assert_eq!(rows[0], ProviderOverview {
            id: "nvidia".into(),
            kind: "api-key".into(),
            state: "connected".into(),
            detail: "API key (environment)".into(),
            fix: None,
            auto: false,
            url: None,
        });
        assert!(rows[1].auto);
        assert_eq!(rows[1].url.as_deref(), Some("https://chat.z.ai/"));
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
        assert_eq!(activity(&row("nvidia", "api-key", "not-connected", None), None), Activity::NotConnected);
        assert_eq!(activity(&row("glm-chat", "web", "not-connected", None), None), Activity::Inactive);
        assert_eq!(activity(&row("groq", "api-key", "not-connected", None), Some(&live(false, Some("GROQ_API_KEY is not set")))), Activity::NotConnected);
    }
}
