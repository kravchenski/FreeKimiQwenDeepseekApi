mod accounts;
mod assets;
mod gateway;
mod overview;
mod status;
mod ui;

use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Root, Theme, ThemeMode};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use accounts::{AccountsCli, SavedAccount};
use gateway::{check_health, Gateway, GatewayConfig};
use overview::{action, activity, detail, display_name, kind_label, Activity, ProviderAction, ProviderOverview};
use status::{fetch_status, now_ms, read_api_key, relative_time, GatewayStatus, ProviderStatus};
use ui::*;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const OVERVIEW_EVERY_POLLS: u32 = 10;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Health {
    Stopped,
    Starting,
    Online,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Page {
    Providers,
    Accounts,
    Requests,
}

impl Page {
    fn title(self) -> &'static str {
        match self {
            Page::Providers => "Providers",
            Page::Accounts => "Accounts",
            Page::Requests => "Requests",
        }
    }

    fn subtitle(self) -> &'static str {
        match self {
            Page::Providers => "See which AI providers are connected and connect the missing ones.",
            Page::Accounts => "Manage saved Qwen accounts and API keys.",
            Page::Requests => "Recent requests routed through the gateway.",
        }
    }
}

struct Shell {
    gateway: Gateway,
    health: Health,
    page: Page,
    status: Option<GatewayStatus>,
    status_error: Option<String>,
    overview: Vec<ProviderOverview>,
    accounts: AccountsCli,
    saved: Vec<SavedAccount>,
    email: Entity<InputState>,
    password: Entity<InputState>,
    api_key: Entity<InputState>,
    busy: bool,
    running: bool,
    message: Option<(bool, String)>,
}

impl Shell {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let config = GatewayConfig::from_env();
        let accounts = AccountsCli::new(config.root.clone(), config.program.clone());
        let base_url = config.base_url();
        let api_key = read_api_key(&config.root);
        cx.spawn(async move |this, cx| {
            let mut polls = 0u32;
            loop {
                let url = base_url.clone();
                let key = api_key.clone();
                let (healthy, status) = cx
                    .background_executor()
                    .spawn(async move {
                        let healthy = check_health(&url).is_ok();
                        (healthy, healthy.then(|| fetch_status(&url, key.as_deref())))
                    })
                    .await;
                polls += 1;
                let updated = this.update(cx, |shell, cx| {
                    shell.apply_health(healthy);
                    match status {
                        Some(Ok(status)) => {
                            shell.status = Some(status);
                            shell.status_error = None;
                        }
                        Some(Err(error)) => shell.status_error = Some(error),
                        None => {
                            shell.status = None;
                            shell.status_error = None;
                        }
                    }
                    if polls.is_multiple_of(OVERVIEW_EVERY_POLLS) {
                        shell.refresh(cx);
                    }
                    cx.notify();
                });
                if updated.is_err() {
                    break;
                }
                cx.background_executor().timer(POLL_INTERVAL).await;
            }
        })
        .detach();
        let mut shell = Self {
            gateway: Gateway::new(config),
            health: Health::Stopped,
            page: Page::Providers,
            status: None,
            status_error: None,
            overview: Vec::new(),
            accounts,
            saved: Vec::new(),
            email: cx.new(|cx| InputState::new(window, cx).placeholder("Qwen email")),
            password: cx.new(|cx| InputState::new(window, cx).placeholder("Password").masked(true)),
            api_key: cx.new(|cx| InputState::new(window, cx).placeholder("nvapi-…").masked(true)),
            busy: false,
            running: false,
            message: None,
        };
        shell.refresh(cx);
        shell
    }

    fn apply_health(&mut self, healthy: bool) {
        self.health = match (healthy, self.gateway.is_running()) {
            (true, _) => Health::Online,
            (false, true) => Health::Starting,
            (false, false) => Health::Stopped,
        };
    }

    fn toggle_gateway(&mut self) {
        if self.gateway.is_running() {
            self.gateway.stop();
            self.health = Health::Stopped;
            return;
        }
        match self.gateway.start() {
            Ok(()) => self.health = Health::Starting,
            Err(error) => self.message = Some((false, format!("Failed to start gateway: {error}"))),
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let cli = self.accounts.clone();
        cx.spawn(async move |this, cx| {
            let (overview, saved) = cx.background_executor().spawn(async move { (cli.overview(), cli.list()) }).await;
            let _ = this.update(cx, |shell, cx| {
                match overview {
                    Ok(rows) => shell.overview = rows,
                    Err(error) => shell.message = Some((false, error)),
                }
                if let Ok(saved) = saved {
                    shell.saved = saved;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn run_command(&mut self, cx: &mut Context<Self>, command: impl FnOnce(AccountsCli) -> Result<String, String> + Send + 'static) {
        let cli = self.accounts.clone();
        self.busy = true;
        self.message = None;
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { command(cli) }).await;
            let _ = this.update(cx, |shell, cx| {
                shell.busy = false;
                shell.message = Some(match result {
                    Ok(output) => (true, last_line(&output, "Done")),
                    Err(error) => (false, last_line(&error, "Failed")),
                });
                shell.refresh(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn browser_blocked(&self) -> bool {
        self.busy || self.running || self.external()
    }

    fn external(&self) -> bool {
        self.health == Health::Online && !self.running
    }

    fn perform(&mut self, action: ProviderAction, cx: &mut Context<Self>) {
        match action {
            ProviderAction::OpenSite(url) => self.run_command(cx, move |cli| cli.open_site(&url)),
            ProviderAction::CaptureQwen => self.run_command(cx, |cli| cli.capture_qwen()),
            ProviderAction::AddApiKey => self.page = Page::Accounts,
            ProviderAction::RunInTerminal(command) => self.message = Some((true, format!("Run in a terminal: {command}"))),
        }
    }

    fn add_account(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let email = self.email.read(cx).value().to_string();
        let password = self.password.read(cx).value().to_string();
        self.password.update(cx, |input, cx| input.set_value("", window, cx));
        self.run_command(cx, move |cli| cli.add("qwen", &email, &password));
    }

    fn add_api_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = self.api_key.read(cx).value().to_string();
        self.api_key.update(cx, |input, cx| input.set_value("", window, cx));
        self.run_command(cx, move |cli| cli.add_api_key("nvidia", &key));
    }

    fn live(&self, id: &str) -> Option<&ProviderStatus> {
        self.status.as_ref()?.providers.iter().find(|provider| provider.id == id)
    }
}

fn last_line(text: &str, fallback: &str) -> String {
    text.lines().rev().find(|line| !line.trim().is_empty() && !line.starts_with('$')).unwrap_or(fallback).trim().to_string()
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.running = self.gateway.is_running();
        div()
            .size_full()
            .flex()
            .font_family(assets::FONT_FAMILY)
            .bg(rgb(CANVAS))
            .text_color(rgb(TEXT))
            .child(self.render_sidebar(cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .bg(rgb(SURFACE))
                    .border_l_1()
                    .border_color(rgb(BORDER))
                    .child(self.render_header())
                    .child(
                        div()
                            .id("content")
                            .flex_1()
                            .overflow_y_scroll()
                            .p_6()
                            .flex()
                            .flex_col()
                            .gap_4()
                            .children(self.render_message())
                            .child(match self.page {
                                Page::Providers => self.render_providers(cx),
                                Page::Accounts => self.render_accounts(cx),
                                Page::Requests => self.render_requests(),
                            }),
                    ),
            )
    }
}

impl Shell {
    fn health_label(&self) -> (&'static str, u32) {
        match self.health {
            Health::Online if self.external() => ("Online (external)", GREEN),
            Health::Online => ("Online", GREEN),
            Health::Starting => ("Starting…", AMBER),
            Health::Stopped => ("Stopped", GRAY),
        }
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> Div {
        let (label, color) = self.health_label();
        let nav = |id: &'static str, name: IconName, page: Page, cx: &mut Context<Self>| {
            nav_item(id, name, page.title(), self.page == page).on_click(cx.listener(move |shell, _, _, cx| {
                shell.page = page;
                cx.notify();
            }))
        };
        div()
            .w(px(236.))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .p_3()
            .bg(rgb(SIDEBAR))
            .child({
                let external = self.external();
                let (label, name, tone) = if self.running {
                    ("Stop API", IconName::Square, Tone::Outline)
                } else if external {
                    ("API is running", IconName::Play, Tone::Outline)
                } else {
                    ("Start API", IconName::Play, Tone::Primary)
                };
                button("gateway-toggle", label, Some(name), tone, !external)
                    .w_full()
                    .h(px(40.))
                    .justify_center()
                    .when(!external, |this| {
                        this.on_click(cx.listener(|shell, _, _, cx| {
                            shell.toggle_gateway();
                            cx.notify();
                        }))
                    })
            })
            .child(nav_heading("Main Menu"))
            .child(nav("nav-providers", IconName::Plug, Page::Providers, cx))
            .child(nav("nav-accounts", IconName::Users, Page::Accounts, cx))
            .child(nav("nav-requests", IconName::Activity, Page::Requests, cx))
            .child(div().mt_4().h(px(1.)).bg(rgb(BORDER)))
            .child(nav_heading("Gateway"))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2p5()
                    .pt_1()
                    .text_sm()
                    .child(div().size(px(8.)).flex_none().rounded_full().bg(rgb(color)))
                    .child(div().min_w_0().overflow_hidden().child(label)),
            )
            .child(div().px_2p5().pt_1().text_xs().text_color(rgb(MUTED)).child(format!("{}/v1", self.gateway.config.base_url())))
            .child(div().mt_4().h(px(1.)).bg(rgb(BORDER)))
            .child(nav_heading("Providers"))
            .children(self.overview.iter().map(|row| {
                let live = self.live(&row.id);
                let state = activity(row, live);
                let tip: SharedString = format!("{} · {}", state.label(), detail(row, live)).into();
                div()
                    .id(SharedString::from(format!("side-{}", row.id)))
                    .flex()
                    .items_center()
                    .gap_2p5()
                    .h(px(34.))
                    .px_2p5()
                    .rounded_md()
                    .cursor_pointer()
                    .text_sm()
                    .text_color(rgb(TEXT))
                    .hover(|style| style.bg(rgb(0xf1f2f4)))
                    .child(provider_mark(&row.id, 22.))
                    .child(div().flex_1().child(display_name(&row.id).to_string()))
                    .child(status_dot(state))
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(|shell, _, _, cx| {
                        shell.page = Page::Providers;
                        cx.notify();
                    }))
            }))
    }

    fn render_header(&self) -> Div {
        div()
            .flex()
            .items_center()
            .justify_between()
            .h(px(76.))
            .flex_none()
            .px_6()
            .border_b_1()
            .border_color(rgb(BORDER))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(self.page.title()))
                    .child(muted(self.page.subtitle()).text_xs()),
            )
    }

    fn render_message(&self) -> Option<Div> {
        let (ok, text) = self.message.clone().or_else(|| self.status_error.clone().map(|error| (false, format!("Status unavailable: {error}"))))?;
        Some(
            div()
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .py_2()
                .rounded_md()
                .text_sm()
                .bg(rgb(if ok { PRIMARY_SOFT } else { 0xfef2f2 }))
                .text_color(rgb(if ok { PRIMARY } else { RED }))
                .child(div().text_size(px(15.)).child(if ok { IconName::CircleCheck } else { IconName::CircleAlert }))
                .child(text),
        )
    }

    fn render_providers(&self, cx: &mut Context<Self>) -> AnyElement {
        let columns = [("Provider", 230.), ("Type", 120.), ("Status", 140.), ("Details", 0.), ("Action", 150.)];
        let active = self.overview.iter().filter(|row| activity(row, self.live(&row.id)) == Activity::Active).count();
        let rows = self.overview.iter().map(|row| {
            let live = self.live(&row.id);
            let state = activity(row, live);
            let action = action(row).filter(|_| state != Activity::Active);
            let enabled = match &action {
                Some(ProviderAction::OpenSite(_) | ProviderAction::CaptureQwen) => !self.browser_blocked(),
                _ => !self.busy,
            };
            table_row()
                .child(
                    cell(230.)
                        .flex()
                        .items_center()
                        .gap_2p5()
                        .child(provider_mark(&row.id, 28.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .child(div().font_weight(FontWeight::MEDIUM).child(display_name(&row.id).to_string()))
                                .child(muted(row.id.clone()).text_xs()),
                        ),
                )
                .child(cell(120.).text_color(rgb(MUTED)).child(kind_label(&row.kind).to_string()))
                .child(cell(140.).flex().child(status_badge(state)))
                .child(cell(0.).text_color(rgb(MUTED)).child(detail(row, live)))
                .child(cell(150.).children(action.map(|action| {
                    let (label, name) = match &action {
                        ProviderAction::OpenSite(_) | ProviderAction::CaptureQwen => ("Sign in", IconName::LogIn),
                        ProviderAction::AddApiKey => ("Add key", IconName::KeyRound),
                        ProviderAction::RunInTerminal(_) => ("How to", IconName::ExternalLink),
                    };
                    button(SharedString::from(format!("action-{}", row.id)), label, Some(name), Tone::Outline, enabled)
                        .when(enabled, |this| {
                            this.on_click(cx.listener(move |shell, _, _, cx| {
                                shell.perform(action.clone(), cx);
                                cx.notify();
                            }))
                        })
                })))
        });
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(muted(format!("{active} of {} providers active", self.overview.len())))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                button("check-sign-ins", "Check sign-ins", Some(IconName::RefreshCw), Tone::Outline, !self.browser_blocked())
                                    .when(!self.browser_blocked(), |this| {
                                        this.on_click(cx.listener(|shell, _, _, cx| {
                                            shell.run_command(cx, |cli| cli.check_sign_ins());
                                            cx.notify();
                                        }))
                                    }),
                            )
                            .child(button("refresh", "Refresh", None, Tone::Primary, !self.busy).on_click(cx.listener(|shell, _, _, cx| {
                                shell.refresh(cx);
                                cx.notify();
                            }))),
                    ),
            )
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(rows)
                    .children(self.overview.is_empty().then(|| table_row().child(muted("Loading providers…")))),
            )
            .children((self.running || self.external()).then(|| {
                muted("Signing in opens the browser profile, which the running gateway is using. Stop the gateway to sign in.").text_xs()
            }))
            .into_any_element()
    }

    fn render_accounts(&self, cx: &mut Context<Self>) -> AnyElement {
        let states = self.status.as_ref().map(|status| status.accounts.as_slice()).unwrap_or_default();
        let columns = [("Account", 0.), ("Provider", 140.), ("Status", 150.), ("Failures", 100.), ("Action", 120.)];
        let rows = self.saved.iter().map(|account| {
            let state = states.iter().find(|state| state.account_id == account.id && state.provider == account.provider);
            let (state_activity, state_label) = match state.map(|state| state.status.as_str()) {
                Some("healthy") => (Activity::Active, "Healthy".to_string()),
                Some("cooldown") => (Activity::Degraded, "Cooling down".to_string()),
                Some("quota_exhausted") => (Activity::Degraded, "Quota exhausted".to_string()),
                Some(other) => (Activity::Inactive, other.replace('_', " ")),
                None => (Activity::Unknown, "Not used yet".to_string()),
            };
            let id = account.id.clone();
            table_row()
                .child(
                    cell(0.)
                        .flex()
                        .items_center()
                        .gap_2p5()
                        .child(provider_mark(&account.provider, 26.))
                        .child(div().flex().flex_col().child(account.email.clone()).child(muted(account.id.clone()).text_xs())),
                )
                .child(cell(140.).text_color(rgb(MUTED)).child(display_name(&account.provider).to_string()))
                .child(cell(150.).flex().child(labeled_badge(state_activity, state_label)))
                .child(cell(100.).text_color(rgb(MUTED)).child(state.map(|state| state.consecutive_failures.to_string()).unwrap_or_else(|| "—".into())))
                .child(cell(120.).child(
                    button(SharedString::from(format!("remove-{}", account.id)), "Remove", Some(IconName::Trash), Tone::Danger, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(move |shell, _, _, cx| {
                            let id = id.clone();
                            shell.run_command(cx, move |cli| cli.remove(&id));
                            cx.notify();
                        }))
                    }),
                ))
        });
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .flex()
                    .gap_4()
                    .child(
                        card()
                            .flex_1()
                            .p_4()
                            .flex()
                            .flex_col()
                            .gap_3()
                            .child(div().flex().items_center().gap_2().child(provider_mark("qwen", 22.)).child(div().font_weight(FontWeight::SEMIBOLD).child("Add Qwen account")))
                            .child(Input::new(&self.email))
                            .child(Input::new(&self.password))
                            .child(
                                div().flex().justify_end().child(
                                    button("add-account", if self.busy { "Working…" } else { "Add account" }, Some(IconName::LogIn), Tone::Primary, !self.busy).when(!self.busy, |this| {
                                        this.on_click(cx.listener(|shell, _, window, cx| {
                                            shell.add_account(window, cx);
                                            cx.notify();
                                        }))
                                    }),
                                ),
                            ),
                    )
                    .child(
                        card()
                            .flex_1()
                            .p_4()
                            .flex()
                            .flex_col()
                            .gap_3()
                            .child(div().flex().items_center().gap_2().child(provider_mark("nvidia", 22.)).child(div().font_weight(FontWeight::SEMIBOLD).child("Add NVIDIA API key")))
                            .child(muted("The key is checked against NVIDIA and stored encrypted.").text_xs())
                            .child(Input::new(&self.api_key))
                            .child(
                                div().flex().justify_end().child(
                                    button("add-key", if self.busy { "Working…" } else { "Save key" }, Some(IconName::KeyRound), Tone::Primary, !self.busy).when(!self.busy, |this| {
                                        this.on_click(cx.listener(|shell, _, window, cx| {
                                            shell.add_api_key(window, cx);
                                            cx.notify();
                                        }))
                                    }),
                                ),
                            ),
                    ),
            )
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(rows)
                    .children(self.saved.is_empty().then(|| table_row().child(muted("No saved accounts yet")))),
            )
            .child(muted(format!("Showing {} saved accounts", self.saved.len())).text_xs())
            .into_any_element()
    }

    fn render_requests(&self) -> AnyElement {
        let Some(status) = &self.status else {
            return card()
                .p_6()
                .flex()
                .flex_col()
                .items_center()
                .gap_2()
                .child(icon(IconName::Activity, GRAY))
                .child(muted("Start the gateway to see requests."))
                .into_any_element();
        };
        let now = now_ms();
        let columns = [("Time", 110.), ("Provider", 150.), ("Model", 0.), ("Latency", 100.), ("Status", 130.)];
        let rows = status.requests.iter().take(50).map(|request| {
            let ok = request.status == "success";
            table_row()
                .child(cell(110.).text_color(rgb(MUTED)).child(relative_time(request.created_at, now)))
                .child(cell(150.).flex().items_center().gap_2().child(provider_mark(&request.provider, 20.)).child(display_name(&request.provider).to_string()))
                .child(
                    cell(0.)
                        .flex()
                        .flex_col()
                        .child(request.model.clone())
                        .children(request.error.clone().map(|error| div().text_xs().text_color(rgb(RED)).child(error.chars().take(120).collect::<String>()))),
                )
                .child(cell(100.).text_color(rgb(MUTED)).child(request.latency_ms.map(|latency| format!("{latency} ms")).unwrap_or_else(|| "—".into())))
                .child(cell(130.).flex().child(labeled_badge(if ok { Activity::Active } else { Activity::Inactive }, if ok { "Success" } else { "Failed" })))
        });
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(rows)
                    .children(status.requests.is_empty().then(|| table_row().child(muted("No requests yet")))),
            )
            .child(muted(format!("Showing {} of {} recent requests", status.requests.len().min(50), status.requests.len())).text_xs())
            .into_any_element()
    }
}

fn main() {
    gpui_kit::application().with_assets(assets::AppAssets).run(|cx| {
        gpui_kit::init(cx);
        Theme::change(ThemeMode::Light, None, cx);
        if let Err(error) = cx.text_system().add_fonts(assets::fonts()) {
            eprintln!("Failed to load fonts: {error}");
        }
        Theme::global_mut(cx).font_family = assets::FONT_FAMILY.into();
        let bounds = Bounds::centered(None, size(px(1180.), px(760.)), cx);
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        cx.spawn(async move |cx| {
            let options = WindowOptions {
                titlebar: Some(TitlebarOptions { title: Some("Free AI Gateway".into()), ..Default::default() }),
                window_bounds: Some(WindowBounds::Windowed(bounds)),
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
