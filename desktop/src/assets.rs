use std::borrow::Cow;

use gpui_kit::assets::{icon_assets, Assets};
use gpui_kit::{AssetSource, Result, SharedString};

icon_assets!(AppIcons, [
    Zap, Plug, Users, Activity, Settings, Sun, Moon, Monitor, Play, Square, RefreshCw, LogIn, KeyRound, ExternalLink, Trash, CircleCheck, CircleAlert,
]);

pub struct AppAssets;

const LOGOS: [(&str, &[u8]); 23] = [
    ("logos/qwen.svg", include_bytes!("../assets/logos/qwen.svg")),
    ("logos/qwen-chat.svg", include_bytes!("../assets/logos/qwen.svg")),
    ("logos/deepseek.svg", include_bytes!("../assets/logos/deepseek.svg")),
    ("logos/glm-chat.svg", include_bytes!("../assets/logos/glm-chat.svg")),
    ("logos/kimi-chat.svg", include_bytes!("../assets/logos/kimi-chat.svg")),
    ("logos/arena-chat.svg", include_bytes!("../assets/logos/arena-chat.svg")),
    ("logos/github-models.svg", include_bytes!("../assets/logos/github-models.svg")),
    ("logos/huggingface.svg", include_bytes!("../assets/logos/huggingface.svg")),
    ("logos/bigmodel.svg", include_bytes!("../assets/logos/bigmodel.svg")),
    ("logos/cohere.svg", include_bytes!("../assets/logos/cohere.svg")),
    ("logos/aion.svg", include_bytes!("../assets/logos/aion.svg")),
    ("logos/zai.svg", include_bytes!("../assets/logos/zai.svg")),
    ("logos/ollama-cloud.svg", include_bytes!("../assets/logos/ollama-cloud.svg")),
    ("logos/opencode-zen.svg", include_bytes!("../assets/logos/opencode-zen.svg")),
    ("logos/kilo.svg", include_bytes!("../assets/logos/kilo.svg")),
    ("logos/nvidia.svg", include_bytes!("../assets/logos/nvidia.svg")),
    ("logos/google.svg", include_bytes!("../assets/logos/google.svg")),
    ("logos/openrouter.svg", include_bytes!("../assets/logos/openrouter.svg")),
    ("logos/groq.svg", include_bytes!("../assets/logos/groq.svg")),
    ("logos/gemini.svg", include_bytes!("../assets/logos/gemini.svg")),
    ("logos/cerebras.svg", include_bytes!("../assets/logos/cerebras.svg")),
    ("logos/mistral.svg", include_bytes!("../assets/logos/mistral.svg")),
    ("logos/sambanova.svg", include_bytes!("../assets/logos/sambanova.svg")),
];

pub const FONT_FAMILY: &str = "Plus Jakarta Sans";

pub fn fonts() -> Vec<Cow<'static, [u8]>> {
    vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/PlusJakartaSans-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/PlusJakartaSans-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/PlusJakartaSans-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/PlusJakartaSans-Bold.ttf")),
    ]
}

pub fn logo_path(provider: &str) -> Option<&'static str> {
    LOGOS.iter().map(|(path, _)| *path).find(|path| *path == format!("logos/{provider}.svg"))
}

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some((_, bytes)) = LOGOS.iter().find(|(logo, _)| *logo == path) {
            return Ok(Some(Cow::Borrowed(*bytes)));
        }
        match AppIcons.load(path)? {
            Some(bytes) => Ok(Some(bytes)),
            None => Assets::new("").load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths: Vec<SharedString> = LOGOS.iter().map(|(logo, _)| *logo).filter(|logo| logo.starts_with(path)).map(Into::into).collect();
        paths.extend(AppIcons.list(path)?);
        paths.extend(Assets::new("").list(path)?);
        Ok(paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::assets::IconName;

    #[test]
    fn serves_app_icons_and_default_component_icons() {
        for icon in [IconName::Zap, IconName::Plug, IconName::KeyRound, IconName::Trash] {
            let path = icon.path();
            assert!(AppAssets.load(&path).unwrap().is_some_and(|bytes| bytes.starts_with(b"<svg")), "{path}");
        }
        assert!(AppAssets.list("icons/").unwrap().len() > 13);
    }

    #[test]
    fn serves_a_logo_for_every_provider() {
        for provider in ["qwen", "qwen-chat", "deepseek", "glm-chat", "kimi-chat", "arena-chat", "nvidia", "google", "openrouter", "groq", "gemini", "cerebras", "mistral", "sambanova", "github-models", "huggingface", "bigmodel", "cohere", "aion", "zai", "ollama-cloud", "opencode-zen", "kilo"] {
            let path = logo_path(provider).unwrap();
            let bytes = AppAssets.load(path).unwrap().unwrap();
            assert!(std::str::from_utf8(&bytes).unwrap().contains("width=\"64\""), "{path}");
        }
        assert_eq!(logo_path("unknown"), None);
        assert_eq!(fonts().len(), 4);
    }
}
