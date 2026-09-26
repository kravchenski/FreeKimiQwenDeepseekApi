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

pub fn is_valid_email(email: &str) -> bool {
    let email = email.trim();
    let Some((user, domain)) = email.split_once('@') else { return false };
    !user.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !email.contains(char::is_whitespace)
}

impl AccountsCli {
    pub fn new(root: PathBuf, program: String) -> Self {
        Self { root, program, prefix: vec!["run".into(), "scripts/accounts.ts".into()] }
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

    pub fn add(&self, provider: &str, email: &str, password: &str) -> Result<String, String> {
        if !is_valid_email(email) {
            return Err("Enter a valid email".into());
        }
        if password.is_empty() {
            return Err("Enter a password".into());
        }
        self.run(&["add", provider, "--email", email.trim()], Some(&format!("{password}\n")))
    }

    pub fn remove(&self, id: &str) -> Result<String, String> {
        self.run(&["remove", id], None)
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
    fn validates_emails() {
        assert!(is_valid_email(" user@example.com "));
        assert!(!is_valid_email("user@"));
        assert!(!is_valid_email("user@localhost"));
        assert!(!is_valid_email("us er@example.com"));
        assert!(!is_valid_email("@example.com"));
    }

    #[test]
    fn rejects_invalid_input_before_running_the_cli() {
        let cli = AccountsCli::new(std::env::temp_dir(), "freeapi-missing-binary".into());
        assert_eq!(cli.add("qwen", "bad", "pw"), Err("Enter a valid email".into()));
        assert_eq!(cli.add("qwen", "a@example.com", ""), Err("Enter a password".into()));
    }

    #[cfg(unix)]
    #[test]
    fn passes_the_password_through_stdin_not_arguments() {
        let root = std::env::temp_dir().join(format!("freeapi-accounts-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("fake.sh");
        std::fs::write(&script, "echo \"args:$*\"\nread password\necho \"stdin:$password\"\n").unwrap();
        let cli = AccountsCli { root: root.clone(), program: "sh".into(), prefix: vec![script.to_string_lossy().into()] };
        let output = cli.add("qwen", "a@example.com", "s3cret").unwrap();
        assert!(output.contains("args:add qwen --email a@example.com"));
        assert!(!output.lines().next().unwrap().contains("s3cret"));
        assert!(output.contains("stdin:s3cret"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
