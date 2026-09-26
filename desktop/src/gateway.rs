use std::fs::{self, File};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub root: PathBuf,
    pub port: u16,
    pub program: String,
    pub args: Vec<String>,
}

impl GatewayConfig {
    pub fn from_env() -> Self {
        let root = std::env::var_os("FREEAPI_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
        let port = std::env::var("UNIFIED_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(3260);
        let program = std::env::var("BUN_PATH").unwrap_or_else(|_| "bun".into());
        Self {
            root,
            port,
            program,
            args: vec!["run".into(), "src/unified/server.ts".into()],
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
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

    #[test]
    fn reports_unreachable_gateways() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(check_health(&format!("http://127.0.0.1:{port}")).is_err());
    }
}
