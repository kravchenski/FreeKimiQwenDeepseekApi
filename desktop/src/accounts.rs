use serde::Deserialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Clone, Debug, PartialEq)]
pub struct SavedAccount {
    pub id: String,
    pub provider: String,
    pub email: String,
}

#[derive(Clone, Debug)]
pub struct AccountsCli {
    pub root: PathBuf,
    pub program: String,
    pub prefix: Vec<String>,
}

pub fn parse_list(output: &str) -> Vec<SavedAccount> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some(id), Some(provider), Some(email), None) => Some(SavedAccount {
                    id: id.into(),
                    provider: provider.into(),
                    email: email.into(),
                }),
                _ => None,
            }
        })
        .collect()
}

pub fn parse_secret_missing(output: &str) -> bool {
    output.lines().filter_map(|line| line.strip_prefix("ACCOUNTS_SECRET: ")).any(|source| source.trim() == "missing")
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct AccountProfile {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub chats: Vec<ChatSignIn>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSignIn {
    pub id: String,
    pub signed_in: Option<bool>,
    pub checked_at: Option<i64>,
    pub reason: Option<String>,
}

pub fn parse_profiles(output: &str) -> Result<Vec<AccountProfile>, String> {
    let start = output.find('[').ok_or_else(|| "Unexpected accounts output".to_string())?;
    serde_json::from_str(&output[start..]).map_err(|error| format!("Unexpected accounts output: {error}"))
}

fn allow_signed_out(result: Result<String, String>) -> Result<String, String> {
    match result {
        Err(output) if output.contains('○') => Ok(output),
        other => other,
    }
}

impl AccountsCli {
    pub fn new(root: PathBuf, program: String, prefix: Vec<String>) -> Self {
        Self { root, program, prefix }
    }

    fn run(&self, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
        let mut child = Command::new(&self.program)
            .args(&self.prefix)
            .args(args)
            .current_dir(&self.root)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to run accounts command: {error}"))?;
        if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(input.as_bytes()).map_err(|error| error.to_string())?;
        }
        let output = child.wait_with_output().map_err(|error| error.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() {
            Ok(stdout)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    }

    pub fn list(&self) -> Result<Vec<SavedAccount>, String> {
        self.run(&["list"], None).map(|output| parse_list(&output))
    }

    pub fn open_site(&self, url: &str) -> Result<String, String> {
        if !url.starts_with("https://") {
            return Err("Only https sites can be opened".into());
        }
        self.run(&["open", url], None)
    }

    pub fn overview(&self) -> Result<Vec<crate::overview::ProviderOverview>, String> {
        self.run(&["--json"], None).and_then(|output| crate::overview::parse_overview(&output))
    }

    pub fn check_sign_ins(&self) -> Result<String, String> {
        allow_signed_out(self.run(&["status"], None))
    }

    pub fn add_api_key(&self, provider: &str, key: &str) -> Result<String, String> {
        let key = key.trim();
        if key.is_empty() {
            return Err("Enter an API key".into());
        }
        self.run(&["add", provider, "--api-key"], Some(&format!("{key}\n")))
    }

    pub fn secret_missing(&self) -> Result<bool, String> {
        self.run(&["secret"], None).map(|output| parse_secret_missing(&output))
    }

    pub fn init_secret(&self) -> Result<String, String> {
        self.run(&["init"], None)
    }

    pub fn profiles(&self) -> Result<Vec<AccountProfile>, String> {
        self.run(&["profiles", "--json"], None).and_then(|output| parse_profiles(&output))
    }

    pub fn add_profile(&self, label: &str) -> Result<String, String> {
        let label = label.trim();
        if label.is_empty() {
            return Err("Enter a name for the account".into());
        }
        let mut args = vec!["profile", "add"];
        args.extend(label.split_whitespace());
        self.run(&args, None)
    }

    pub fn remove_profile(&self, id: &str) -> Result<String, String> {
        self.run(&["profile", "remove", id], None)
    }

    pub fn connect_profile(&self, id: &str) -> Result<String, String> {
        allow_signed_out(self.run(&["connect", "--profile", id], None))
    }

    pub fn check_profile(&self, id: &str) -> Result<String, String> {
        allow_signed_out(self.run(&["status", "--profile", id], None))
    }

    pub fn remove(&self, id: &str) -> Result<String, String> {
        self.run(&["remove", id], None)
    }

    pub fn auto_settings(&self) -> Result<crate::settings::AutoSettings, String> {
        self.run(&["auto"], None).and_then(|output| crate::settings::parse_auto(&output).ok_or_else(|| "Unexpected auto settings output".to_string()))
    }

    pub fn set_auto_focus(&self, focus: &str) -> Result<String, String> {
        self.run(&["auto", "--focus", focus], None)
    }

    pub fn set_auto_mode(&self, mode: &str) -> Result<String, String> {
        self.run(&["auto", "--mode", mode], None)
    }

    pub fn set_auto(&self, provider: &str, auto: bool) -> Result<String, String> {
        self.run(&["provider", provider, "--auto", if auto { "on" } else { "off" }], None)
    }

    pub fn check_site(&self, url: &str) -> Result<String, String> {
        let host = url.trim_start_matches("https://").trim_end_matches('/').to_string();
        self.check_sign_ins().map(|output| output.lines().find(|line| line.contains(&host)).unwrap_or("Checked").trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tab_separated_accounts_and_skips_other_lines() {
        let output = "qwen-1a2b\tqwen\ta@example.com\nNo saved accounts.\nbroken\tline\nx\ty\tz\textra";
        assert_eq!(parse_list(output), vec![SavedAccount {
            id: "qwen-1a2b".into(),
            provider: "qwen".into(),
            email: "a@example.com".into(),
        }]);
    }

    #[test]
    fn refuses_to_open_non_https_sites() {
        let cli = AccountsCli::new(std::env::temp_dir(), "freeapi-missing-binary".into(), Vec::new());
        assert_eq!(cli.open_site("http://chat.z.ai"), Err("Only https sites can be opened".into()));
    }

    #[cfg(unix)]
    #[test]
    fn passes_web_chat_commands_to_the_cli() {
        let root = std::env::temp_dir().join(format!("freeapi-web-chat-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("echo.sh");
        std::fs::write(&script, "echo \"args:$*\"\n").unwrap();
        let cli = AccountsCli { root: root.clone(), program: "sh".into(), prefix: vec![script.to_string_lossy().into()] };
        assert_eq!(cli.open_site("https://www.kimi.ai").unwrap(), "args:open https://www.kimi.ai");
        assert_eq!(cli.init_secret().unwrap(), "args:init");
        assert_eq!(cli.check_sign_ins().unwrap(), "args:status");
        assert_eq!(cli.add_profile("  Work   laptop ").unwrap(), "args:profile add Work laptop");
        assert_eq!(cli.connect_profile("acct-1").unwrap(), "args:connect --profile acct-1");
        assert_eq!(cli.check_profile("acct-1").unwrap(), "args:status --profile acct-1");
        assert_eq!(cli.remove_profile("acct-1").unwrap(), "args:profile remove acct-1");
        assert_eq!(cli.set_auto_focus("coding").unwrap(), "args:auto --focus coding");
        assert_eq!(cli.set_auto_mode("race").unwrap(), "args:auto --mode race");
        assert_eq!(cli.add_profile(" "), Err("Enter a name for the account".into()));
        assert_eq!(cli.set_auto("nvidia", false).unwrap(), "args:provider nvidia --auto off");
        assert_eq!(cli.set_auto("glm-chat", true).unwrap(), "args:provider glm-chat --auto on");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_a_missing_accounts_secret() {
        assert!(parse_secret_missing("$ bun run scripts/accounts.ts secret\nACCOUNTS_SECRET: missing"));
        assert!(!parse_secret_missing("ACCOUNTS_SECRET: keyring"));
        assert!(!parse_secret_missing("ACCOUNTS_SECRET: environment"));
    }

    #[test]
    fn parses_browser_accounts_with_their_chat_sign_ins() {
        let output = "$ bun run scripts/accounts.ts profiles --json\n[{\"id\":\"default\",\"label\":\"Main\",\"chats\":[{\"id\":\"glm-chat\",\"signedIn\":true,\"checkedAt\":5,\"reason\":null},{\"id\":\"kimi-chat\",\"signedIn\":null,\"checkedAt\":null,\"reason\":null}]}]";
        let profiles = parse_profiles(output).unwrap();
        assert_eq!(profiles[0].label, "Main");
        assert_eq!(profiles[0].chats[0], ChatSignIn { id: "glm-chat".into(), signed_in: Some(true), checked_at: Some(5), reason: None });
        assert_eq!(profiles[0].chats[1].signed_in, None);
        assert!(parse_profiles("nothing").is_err());
    }

    #[test]
    fn rejects_an_empty_api_key_before_running_the_cli() {
        let cli = AccountsCli::new(std::env::temp_dir(), "freeapi-missing-binary".into(), Vec::new());
        assert_eq!(cli.add_api_key("nvidia", "  "), Err("Enter an API key".into()));
    }

    #[cfg(unix)]
    #[test]
    fn passes_the_api_key_through_stdin_not_arguments() {
        let root = std::env::temp_dir().join(format!("freeapi-accounts-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("fake.sh");
        std::fs::write(&script, "echo \"args:$*\"\nread secret\necho \"stdin:$secret\"\n").unwrap();
        let cli = AccountsCli { root: root.clone(), program: "sh".into(), prefix: vec![script.to_string_lossy().into()] };
        let output = cli.add_api_key("nvidia", " s3cret ").unwrap();
        assert!(output.contains("args:add nvidia --api-key"));
        assert!(!output.lines().next().unwrap().contains("s3cret"));
        assert!(output.contains("stdin:s3cret"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
