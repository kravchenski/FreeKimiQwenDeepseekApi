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

pub fn parse_google_accounts(output: &str) -> Vec<String> {
    output.lines().filter_map(|line| line.strip_prefix("google\t")).map(|email| email.trim().to_string()).filter(|email| is_valid_email(email)).collect()
}

pub fn is_valid_email(email: &str) -> bool {
    let email = email.trim();
    let Some((user, domain)) = email.split_once('@') else { return false };
    !user.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !email.contains(char::is_whitespace)
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
        match self.run(&["status"], None) {
            Ok(output) => Ok(output),
            Err(output) if output.contains('○') => Ok(output),
            Err(error) => Err(error),
        }
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

    pub fn add_google(&self) -> Result<Vec<String>, String> {
        self.run(&["google"], None).map(|output| parse_google_accounts(&output))
    }

    pub fn list_google(&self) -> Result<Vec<String>, String> {
        self.run(&["google", "--list"], None).map(|output| parse_google_accounts(&output))
    }

    pub fn remove(&self, id: &str) -> Result<String, String> {
        self.run(&["remove", id], None)
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
        assert_eq!(cli.list_google().unwrap(), Vec::<String>::new());
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
    fn parses_google_accounts_from_cli_output() {
        let output = "$ bun run scripts/accounts.ts google --list\ngoogle\ta@gmail.com\nNo Google accounts found\ngoogle\tnot-an-email\ngoogle\tb@example.org";
        assert_eq!(parse_google_accounts(output), vec!["a@gmail.com".to_string(), "b@example.org".to_string()]);
    }

    #[test]
    fn validates_emails() {
        assert!(is_valid_email(" user@example.com "));
        assert!(!is_valid_email("user@"));
        assert!(!is_valid_email("user@localhost"));
        assert!(!is_valid_email("us er@example.com"));
        assert!(!is_valid_email("@example.com"));
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
