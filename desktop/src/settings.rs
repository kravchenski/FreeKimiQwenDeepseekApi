use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    #[default]
    Light,
    Dark,
    System,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct DesktopSettings {
    #[serde(default)]
    pub theme: ThemeChoice,
}

fn settings_file(root: &Path) -> PathBuf {
    root.join("data").join("desktop.json")
}

pub fn load(root: &Path) -> DesktopSettings {
    std::fs::read_to_string(settings_file(root)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

pub fn save(root: &Path, settings: &DesktopSettings) -> Result<(), String> {
    let file = settings_file(root);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(file, text).map_err(|error| error.to_string())
}

#[derive(Clone, Debug, PartialEq)]
pub struct AutoSettings {
    pub focus: String,
    pub mode: String,
}

pub fn parse_auto(output: &str) -> Option<AutoSettings> {
    let value = |prefix: &str| output.lines().find_map(|line| line.strip_prefix(prefix)).map(|value| value.trim().to_string());
    Some(AutoSettings { focus: value("auto focus: ")?, mode: value("auto mode: ")? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads_the_theme_and_defaults_to_light() {
        let root = std::env::temp_dir().join(format!("freeapi-settings-test-{}", std::process::id()));
        assert_eq!(load(&root).theme, ThemeChoice::Light);
        save(&root, &DesktopSettings { theme: ThemeChoice::System }).unwrap();
        assert_eq!(load(&root).theme, ThemeChoice::System);
        std::fs::write(settings_file(&root), "not json").unwrap();
        assert_eq!(load(&root), DesktopSettings::default());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_auto_settings_from_the_cli() {
        let output = "$ bun run scripts/accounts.ts auto\nauto focus: coding\nauto mode: race";
        assert_eq!(parse_auto(output), Some(AutoSettings { focus: "coding".into(), mode: "race".into() }));
        assert_eq!(parse_auto("nothing"), None);
    }
}
