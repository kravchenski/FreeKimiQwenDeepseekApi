use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const STOP_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub root: PathBuf,
    pub port: u16,
    pub program: String,
    pub args: Vec<String>,
    pub accounts_program: String,
    pub accounts_args: Vec<String>,
}

pub const GATEWAY_SIDECAR: &str = "freeapi-gateway";
pub const ACCOUNTS_SIDECAR: &str = "freeapi-accounts";
const APP_DIR: &str = "Free AI Gateway";

pub fn sidecar(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

pub fn installed_sidecars(exe_dir: Option<&Path>) -> Option<(PathBuf, PathBuf)> {
    let dir = exe_dir?;
    let gateway = sidecar(dir, GATEWAY_SIDECAR);
    let accounts = sidecar(dir, ACCOUNTS_SIDECAR);
    (gateway.is_file() && accounts.is_file()).then_some((gateway, accounts))
}

pub fn app_data_dir(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let non_empty = |name: &str| env(name).filter(|value| !value.is_empty()).map(PathBuf::from);
    if cfg!(windows) {
        non_empty("APPDATA").map(|dir| dir.join(APP_DIR))
    } else if cfg!(target_os = "macos") {
        non_empty("HOME").map(|home| home.join("Library/Application Support").join(APP_DIR))
    } else {
        non_empty("XDG_DATA_HOME")
            .or_else(|| non_empty("HOME").map(|home| home.join(".local/share")))
            .map(|dir| dir.join("free-ai-gateway"))
    }
}

impl GatewayConfig {
    pub fn from_env() -> Self {
        let root = resolve_root(
            std::env::var_os("FREEAPI_ROOT").map(PathBuf::from),
            std::env::current_dir().ok(),
        );
        let port = std::env::var("UNIFIED_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(3260);
        let explicit_root = std::env::var_os("FREEAPI_ROOT").is_some();
        let exe = std::env::current_exe().ok();
        let installed = (!explicit_root).then(|| installed_sidecars(exe.as_deref().and_then(Path::parent))).flatten();
        if let (Some((gateway, accounts)), Some(data)) = (installed, app_data_dir(|name| std::env::var(name).ok())) {
            let _ = fs::create_dir_all(&data);
            return Self {
                root: data,
                port,
                program: gateway.to_string_lossy().into(),
                args: Vec::new(),
                accounts_program: accounts.to_string_lossy().into(),
                accounts_args: Vec::new(),
            };
        }
        let program = std::env::var("BUN_PATH").unwrap_or_else(|_| "bun".into());
        Self {
            root,
            port,
            program: program.clone(),
            args: vec!["run".into(), SERVER_ENTRY.into()],
            accounts_program: program,
            accounts_args: vec!["run".into(), ACCOUNTS_ENTRY.into()],
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

const SERVER_ENTRY: &str = "src/unified/server.ts";
const ACCOUNTS_ENTRY: &str = "scripts/accounts.ts";

pub fn resolve_root(explicit: Option<PathBuf>, cwd: Option<PathBuf>) -> PathBuf {
    explicit
        .or_else(|| cwd.filter(|dir| dir.join(SERVER_ENTRY).is_file()))
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
}

pub struct Gateway {
    pub config: GatewayConfig,
    child: Option<Child>,
}

impl Gateway {
    pub fn new(config: GatewayConfig) -> Self {
        Self { config, child: None }
    }

    pub fn is_running(&mut self) -> bool {
        match self.child.as_mut().map(Child::try_wait) {
            Some(Ok(None)) => true,
            Some(_) => {
                self.child = None;
                false
            }
            None => false,
        }
    }

    pub fn start(&mut self) -> std::io::Result<()> {
        if self.is_running() {
            return Ok(());
        }
        let logs = self.config.root.join("logs");
        fs::create_dir_all(&logs)?;
        let log = File::create(logs.join("desktop-gateway.log"))?;
        let child = Command::new(&self.config.program)
            .args(&self.config.args)
            .current_dir(&self.config.root)
            .env("UNIFIED_PORT", self.config.port.to_string())
            .env("HOST", "127.0.0.1")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()?;
        self.child = Some(child);
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = terminate(child.id());
            let deadline = Instant::now() + STOP_GRACE;
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn terminate(pid: u32) -> Result<(), String> {
    let status = if cfg!(windows) {
        Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    } else {
        Command::new("kill").args(["-TERM", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    };
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("Could not stop process {pid} ({status})")),
        Err(error) => Err(format!("Could not stop process {pid}: {error}")),
    }
}

#[derive(serde::Deserialize)]
struct Health {
    pid: Option<u32>,
}

pub fn gateway_pid(base_url: &str) -> Result<u32, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .into();
    let health: Health = agent
        .get(format!("{base_url}/health"))
        .call()
        .map_err(|error| error.to_string())?
        .body_mut()
        .read_json()
        .map_err(|error| error.to_string())?;
    health.pid.ok_or_else(|| "This gateway is too old to be stopped from the app; stop it in its terminal".to_string())
}

pub fn stop_external(base_url: &str) -> Result<u32, String> {
    let pid = gateway_pid(base_url)?;
    if pid == std::process::id() {
        return Err("Refusing to stop the app itself".into());
    }
    terminate(pid).map(|()| pid)
}

pub fn check_health(base_url: &str) -> Result<(), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .into();
    agent
        .get(format!("{base_url}/health"))
        .call()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn config(program: &str, args: &[&str], port: u16) -> GatewayConfig {
        GatewayConfig {
            root: std::env::temp_dir().join("freeapi-desktop-test"),
            port,
            program: program.into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            accounts_program: program.into(),
            accounts_args: Vec::new(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn starts_and_stops_the_gateway_process() {
        let mut gateway = Gateway::new(config("sleep", &["30"], 0));
        assert!(!gateway.is_running());
        gateway.start().unwrap();
        assert!(gateway.is_running());
        gateway.stop();
        assert!(!gateway.is_running());
    }

    #[cfg(unix)]
    #[test]
    fn notices_when_the_process_exits_on_its_own() {
        let mut gateway = Gateway::new(config("true", &[], 0));
        gateway.start().unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(!gateway.is_running());
    }

    #[test]
    fn resolves_the_repository_root() {
        let repo = std::env::temp_dir().join(format!("freeapi-root-test-{}", std::process::id()));
        std::fs::create_dir_all(repo.join("src/unified")).unwrap();
        std::fs::write(repo.join(SERVER_ENTRY), "").unwrap();
        let elsewhere = std::env::temp_dir();

        assert_eq!(resolve_root(Some("/explicit".into()), Some(repo.clone())), PathBuf::from("/explicit"));
        assert_eq!(resolve_root(None, Some(repo.clone())), repo);
        assert_eq!(
            resolve_root(None, Some(elsewhere)),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
        );
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn finds_sidecars_next_to_the_installed_app() {
        let dir = std::env::temp_dir().join(format!("freeapi-sidecar-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(installed_sidecars(Some(&dir)), None);
        std::fs::write(sidecar(&dir, GATEWAY_SIDECAR), "").unwrap();
        assert_eq!(installed_sidecars(Some(&dir)), None);
        std::fs::write(sidecar(&dir, ACCOUNTS_SIDECAR), "").unwrap();
        assert_eq!(installed_sidecars(Some(&dir)), Some((sidecar(&dir, GATEWAY_SIDECAR), sidecar(&dir, ACCOUNTS_SIDECAR))));
        assert_eq!(installed_sidecars(None), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_installed_data_in_the_user_data_directory() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string());
        if cfg!(windows) {
            assert_eq!(app_data_dir(env(&[("APPDATA", "C:/Users/me/AppData/Roaming")])), Some(PathBuf::from("C:/Users/me/AppData/Roaming/Free AI Gateway")));
        } else if cfg!(target_os = "macos") {
            assert_eq!(app_data_dir(env(&[("HOME", "/Users/me")])), Some(PathBuf::from("/Users/me/Library/Application Support/Free AI Gateway")));
        } else {
            assert_eq!(app_data_dir(env(&[("HOME", "/home/me")])), Some(PathBuf::from("/home/me/.local/share/free-ai-gateway")));
            assert_eq!(app_data_dir(env(&[("HOME", "/home/me"), ("XDG_DATA_HOME", "/data")])), Some(PathBuf::from("/data/free-ai-gateway")));
        }
        assert_eq!(app_data_dir(env(&[])), None);
    }

    #[test]
    fn reports_start_errors_for_a_missing_program() {
        let mut gateway = Gateway::new(config("freeapi-missing-binary", &[], 0));
        assert!(gateway.start().is_err());
        assert!(!gateway.is_running());
    }

    #[test]
    fn checks_health_over_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
        assert!(check_health(&format!("http://127.0.0.1:{port}")).is_ok());
    }

    fn serve_once(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        });
        port
    }

    #[test]
    fn reads_the_gateway_pid_from_health() {
        let port = serve_once(r#"{"status":"ok","service":"unified","pid":4242}"#);
        assert_eq!(gateway_pid(&format!("http://127.0.0.1:{port}")), Ok(4242));
        let old = serve_once(r#"{"status":"ok","service":"unified"}"#);
        assert!(gateway_pid(&format!("http://127.0.0.1:{old}")).unwrap_err().contains("too old"));
    }

    #[cfg(unix)]
    #[test]
    fn terminates_a_process_gracefully() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        terminate(child.id()).unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert!(terminate(child.id()).is_err());
    }

    #[test]
    fn reports_unreachable_gateways() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(check_health(&format!("http://127.0.0.1:{port}")).is_err());
    }
}
