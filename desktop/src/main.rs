mod accounts;
mod gateway;
mod status;

use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Disableable, Root};
use gpui_kit::*;

use accounts::{AccountsCli, SavedAccount};
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
    accounts: AccountsCli,
    saved: Vec<SavedAccount>,
    email: Entity<InputState>,
    password: Entity<InputState>,
    account_busy: bool,
    account_message: Option<(bool, String)>,
}

impl Shell {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let config = GatewayConfig::from_env();
        let accounts = AccountsCli::new(config.root.clone(), config.program.clone());
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
        let mut shell = Self {
            gateway: Gateway::new(config),
            health: Health::Stopped,
            status: None,
            status_error: None,
            error: None,
            accounts,
            saved: Vec::new(),
            email: cx.new(|cx| InputState::new(window, cx).placeholder("Qwen email")),
            password: cx.new(|cx| InputState::new(window, cx).placeholder("Password").masked(true)),
            account_busy: false,
            account_message: None,
        };
        shell.refresh_accounts(cx);
        shell
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

    fn refresh_accounts(&mut self, cx: &mut Context<Self>) {
        let cli = self.accounts.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { cli.list() }).await;
            let _ = this.update(cx, |shell, cx| {
                match result {
                    Ok(saved) => shell.saved = saved,
                    Err(error) => shell.account_message = Some((false, error)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn run_account_command(&mut self, cx: &mut Context<Self>, command: impl FnOnce(AccountsCli) -> Result<String, String> + Send + 'static) {
        let cli = self.accounts.clone();
        self.account_busy = true;
        self.account_message = None;
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { command(cli) }).await;
            let _ = this.update(cx, |shell, cx| {
                shell.account_busy = false;
                shell.account_message = Some(match result {
                    Ok(output) => (true, output.lines().last().unwrap_or("Done").to_string()),
                    Err(error) => (false, error.lines().last().unwrap_or("Failed").to_string()),
                });
                shell.refresh_accounts(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn add_account(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let email = self.email.read(cx).value().to_string();
        let password = self.password.read(cx).value().to_string();
        self.password.update(cx, |input, cx| input.set_value("", window, cx));
        self.run_account_command(cx, move |cli| cli.add("qwen", &email, &password));
    }

    fn remove_account(&mut self, id: String, cx: &mut Context<Self>) {
        self.run_account_command(cx, move |cli| cli.remove(&id));
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
            .child(self.render_accounts(cx))
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
    fn render_accounts(&self, cx: &mut Context<Self>) -> AnyElement {
        let states = self.status.as_ref().map(|status| status.accounts.as_slice()).unwrap_or_default();
        let saved = self.saved.iter().map(|account| {
            let state = states.iter().find(|state| state.account_id == account.id && state.provider == account.provider);
            let id = account.id.clone();
            row()
                .child(dot(state.map(|state| account_color(&state.status)).unwrap_or(MUTED)))
                .child(account.email.clone())
                .child(div().text_color(rgb(MUTED)).child(match state {
                    Some(state) => format!("{} · {} · {} failures", account.provider, state.status, state.consecutive_failures),
                    None => format!("{} · not used yet", account.provider),
                }))
                .child(
                    Button::new(SharedString::from(format!("remove-{}", account.id)))
                        .ghost()
                        .label("Remove")
                        .disabled(self.account_busy)
                        .on_click(cx.listener(move |shell, _, _, cx| {
                            shell.remove_account(id.clone(), cx);
                            cx.notify();
                        })),
                )
        });
        section("Accounts")
            .children(saved)
            .children(self.saved.is_empty().then(|| row().text_color(rgb(MUTED)).child("No saved accounts")))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .items_center()
                    .child(div().w(px(220.)).child(Input::new(&self.email)))
                    .child(div().w(px(180.)).child(Input::new(&self.password)))
                    .child(
                        Button::new("add-account")
                            .primary()
                            .label(if self.account_busy { "Signing in…" } else { "Add Qwen account" })
                            .disabled(self.account_busy)
                            .on_click(cx.listener(|shell, _, window, cx| {
                                shell.add_account(window, cx);
                                cx.notify();
                            })),
                    ),
            )
            .children(self.account_message.clone().map(|(ok, message)| {
                div().text_sm().text_color(rgb(if ok { GREEN } else { RED })).child(message)
            }))
            .into_any_element()
    }

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
                let view = cx.new(|cx| Shell::new(window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("failed to open window");
        })
        .detach();
    });
}
