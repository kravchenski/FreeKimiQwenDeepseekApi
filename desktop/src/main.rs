mod gateway;

use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::{Disableable, Root};
use gpui_kit::*;

use gateway::{check_health, Gateway, GatewayConfig};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq)]
enum Health {
    Stopped,
    Starting,
    Online,
}

struct Shell {
    gateway: Gateway,
    health: Health,
    error: Option<String>,
}

impl Shell {
    fn new(cx: &mut Context<Self>) -> Self {
        let config = GatewayConfig::from_env();
        let base_url = config.base_url();
        cx.spawn(async move |this, cx| loop {
            let url = base_url.clone();
            let result = cx.background_executor().spawn(async move { check_health(&url) }).await;
            let updated = this.update(cx, |shell, cx| {
                shell.apply_health(result.is_ok());
                cx.notify();
            });
            if updated.is_err() {
                break;
            }
            cx.background_executor().timer(POLL_INTERVAL).await;
        })
        .detach();
        Self { gateway: Gateway::new(config), health: Health::Stopped, error: None }
    }

    fn apply_health(&mut self, healthy: bool) {
        self.health = match (healthy, self.gateway.is_running()) {
            (true, _) => Health::Online,
            (false, true) => Health::Starting,
            (false, false) => Health::Stopped,
        };
    }

    fn start(&mut self) {
        self.error = self.gateway.start().err().map(|error| format!("Failed to start gateway: {error}"));
        if self.error.is_none() {
            self.health = Health::Starting;
        }
    }

    fn stop(&mut self) {
        self.gateway.stop();
        self.health = Health::Stopped;
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let running = self.gateway.is_running();
        let (label, color) = match self.health {
            Health::Online => ("Online", rgb(0x22c55e)),
            Health::Starting => ("Starting…", rgb(0xeab308)),
            Health::Stopped => ("Stopped", rgb(0x9ca3af)),
        };
        div()
            .size_full()
            .p_6()
            .flex()
            .flex_col()
            .gap_4()
            .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child("Free AI Gateway"))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().size_3().rounded_full().bg(color))
                    .child(label),
            )
            .child(div().text_sm().child(format!("{}/v1", self.gateway.config.base_url())))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        Button::new("start")
                            .primary()
                            .label("Start")
                            .disabled(running)
                            .on_click(cx.listener(|shell, _, _, cx| {
                                shell.start();
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("stop")
                            .danger()
                            .label("Stop")
                            .disabled(!running)
                            .on_click(cx.listener(|shell, _, _, cx| {
                                shell.stop();
                                cx.notify();
                            })),
                    ),
            )
            .children(self.error.clone().map(|error| div().text_sm().text_color(rgb(0xef4444)).child(error)))
    }
}

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        cx.spawn(async move |cx| {
            let options = WindowOptions {
                titlebar: Some(TitlebarOptions { title: Some("Free AI Gateway".into()), ..Default::default() }),
                ..Default::default()
            };
            cx.open_window(options, |window, cx| {
                let view = cx.new(Shell::new);
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("failed to open window");
        })
        .detach();
    });
}
