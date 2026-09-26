mod gateway;
mod status;

use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::{Disableable, Root};
use gpui_kit::*;

use gateway::{check_health, Gateway, GatewayConfig};
use status::{fetch_status, now_ms, read_api_key, relative_time, GatewayStatus};

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
    status: Option<GatewayStatus>,
    status_error: Option<String>,
    error: Option<String>,
}

impl Shell {
    fn new(cx: &mut Context<Self>) -> Self {
        let config = GatewayConfig::from_env();
        let base_url = config.base_url();
        let api_key = read_api_key(&config.root);
        cx.spawn(async move |this, cx| loop {
            let url = base_url.clone();
            let key = api_key.clone();
            let (healthy, status) = cx
                .background_executor()
                .spawn(async move {
                    let healthy = check_health(&url).is_ok();
                    (healthy, healthy.then(|| fetch_status(&url, key.as_deref())))
                })
                .await;
            let updated = this.update(cx, |shell, cx| {
                shell.apply_health(healthy);
                match status {
                    Some(Ok(status)) => {
                        shell.status = Some(status);
                        shell.status_error = None;
                    }
                    Some(Err(error)) => shell.status_error = Some(error),
                    None => shell.status_error = None,
                }
                cx.notify();
            });
            if updated.is_err() {
                break;
            }
            cx.background_executor().timer(POLL_INTERVAL).await;
        })
        .detach();
        Self { gateway: Gateway::new(config), health: Health::Stopped, status: None, status_error: None, error: None }
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
            Health::Online => ("Online", rgb(GREEN)),
            Health::Starting => ("Starting…", rgb(YELLOW)),
            Health::Stopped => ("Stopped", rgb(MUTED)),
        };
        div()
            .id("shell")
            .size_full()
            .overflow_y_scroll()
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
            .children(self.error.clone().map(|error| div().text_sm().text_color(rgb(RED)).child(error)))
            .children(self.status_error.clone().map(|error| div().text_sm().text_color(rgb(RED)).child(format!("Status unavailable: {error}"))))
            .child(self.render_status())
    }
}

const MUTED: u32 = 0x9ca3af;
const GREEN: u32 = 0x22c55e;
const YELLOW: u32 = 0xeab308;
const RED: u32 = 0xef4444;

fn section(title: &'static str) -> Div {
    div().flex().flex_col().gap_1().child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(title))
}

fn dot(color: u32) -> Div {
    div().size_2().flex_none().rounded_full().bg(rgb(color))
}

fn row() -> Div {
    div().flex().items_center().gap_2().text_sm()
}

fn account_color(status: &str) -> u32 {
    match status {
        "healthy" => GREEN,
        "cooldown" | "quota_exhausted" => YELLOW,
        _ => RED,
    }
}

impl Shell {
    fn render_status(&self) -> AnyElement {
        let Some(status) = &self.status else {
            return div()
                .text_sm()
                .text_color(rgb(MUTED))
                .child("Start the gateway to see providers, accounts and requests.")
                .into_any_element();
        };
        let now = now_ms();
        let providers = status.providers.iter().map(|provider| {
            row()
                .child(dot(if provider.available { GREEN } else { RED }))
                .child(provider.id.clone())
                .children(provider.reason.clone().map(|reason| div().text_color(rgb(MUTED)).child(reason)))
        });
        let accounts = status.accounts.iter().map(|account| {
            row()
                .child(dot(account_color(&account.status)))
                .child(account.account_id.clone())
                .child(div().text_color(rgb(MUTED)).child(format!(
                    "{} · {} · {} failures",
                    account.provider, account.status, account.consecutive_failures
                )))
        });
        let requests = status.requests.iter().take(20).map(|request| {
            row()
                .child(dot(if request.status == "success" { GREEN } else { RED }))
                .child(div().w(px(64.)).text_color(rgb(MUTED)).child(relative_time(request.created_at, now)))
                .child(format!("{} / {}", request.provider, request.model))
                .children(request.latency_ms.map(|latency| div().text_color(rgb(MUTED)).child(format!("{latency} ms"))))
                .children(request.error.clone().map(|error| {
                    div().text_color(rgb(RED)).child(error.chars().take(80).collect::<String>())
                }))
        });
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(section("Providers").children(providers))
            .child(if status.accounts.is_empty() {
                section("Accounts").child(row().text_color(rgb(MUTED)).child("No saved accounts"))
            } else {
                section("Accounts").children(accounts)
            })
            .child(if status.requests.is_empty() {
                section("Recent requests").child(row().text_color(rgb(MUTED)).child("No requests yet"))
            } else {
                section("Recent requests").children(requests)
            })
            .into_any_element()
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
