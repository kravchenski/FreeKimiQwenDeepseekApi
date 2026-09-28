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

use accounts::{AccountProfile, AccountsCli, SavedAccount};
use gateway::{check_health, open_in_browser, stop_external, Gateway, GatewayConfig};
use overview::{activity, detail, display_name, kind_label, Activity, ProviderOverview};
use status::{fetch_status, now_ms, read_api_key, relative_time, GatewayStatus, ProviderStatus};
use ui::*;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const OVERVIEW_EVERY_POLLS: u32 = 10;
const COMPACT_WIDTH: f32 = 1100.;

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
    Provider,
}

impl Page {
    fn title(self) -> &'static str {
        match self {
            Page::Providers => "Providers",
            Page::Accounts => "Accounts",
            Page::Requests => "Requests",
            Page::Provider => "Provider",
        }
    }

    fn subtitle(self) -> &'static str {
        match self {
            Page::Providers => "See which AI providers are connected and connect the missing ones.",
            Page::Accounts => "Browser accounts signed in to the web chats, and API keys.",
            Page::Requests => "Recent requests routed through the gateway.",
            Page::Provider => "Connection, routing and models of this provider.",
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
    profiles: Vec<AccountProfile>,
    profile_name: Entity<InputState>,
    api_key: Entity<InputState>,
    key_provider: Option<String>,
    request_filter: Option<String>,
    selected_provider: Option<String>,
    busy: bool,
    running: bool,
    compact: bool,
    locked: bool,
    message: Option<(bool, String)>,
}

impl Shell {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let config = GatewayConfig::from_env();
        let accounts = AccountsCli::new(config.root.clone(), config.accounts_program.clone(), config.accounts_args.clone());
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
            profiles: Vec::new(),
            profile_name: cx.new(|cx| InputState::new(window, cx).placeholder("Account name, e.g. Work")),
            api_key: cx.new(|cx| InputState::new(window, cx).placeholder("Paste the API key").masked(true)),
            key_provider: None,
            request_filter: None,
            selected_provider: None,
            busy: false,
            running: false,
            compact: false,
            locked: false,
            message: None,
        };
        shell.refresh(cx);
        shell
    }

    fn add_profile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let label = self.profile_name.read(cx).value().to_string();
        self.profile_name.update(cx, |input, cx| input.set_value("", window, cx));
        self.run_command(cx, move |cli| {
            cli.add_profile(&label).map(|_| format!("Added {}. Stop the API if it runs, then press Connect chats on its card to sign it in.", label.trim()))
        });
    }

    fn key_providers(&self) -> Vec<String> {
        self.overview.iter().filter(|row| row.kind == "api-key").map(|row| row.id.clone()).collect()
    }

    fn selected_key_provider(&self) -> Option<String> {
        let providers = self.key_providers();
        self.key_provider.clone().filter(|id| providers.contains(id)).or_else(|| providers.first().cloned())
    }

    fn registry_locked(&self) -> bool {
        self.locked
    }

    fn apply_health(&mut self, healthy: bool) {
        self.health = match (healthy, self.gateway.is_running()) {
            (true, _) => Health::Online,
            (false, true) => Health::Starting,
            (false, false) => Health::Stopped,
        };
    }

    fn toggle_gateway(&mut self, cx: &mut Context<Self>) {
        if self.gateway.is_running() {
            self.gateway.stop();
            self.health = Health::Stopped;
            return;
        }
        if self.external() {
            let base_url = self.gateway.config.base_url();
            self.busy = true;
            cx.spawn(async move |this, cx| {
                let result = cx.background_executor().spawn(async move { stop_external(&base_url) }).await;
                let _ = this.update(cx, |shell, cx| {
                    shell.busy = false;
                    shell.message = Some(match result {
                        Ok(pid) => {
                            shell.health = Health::Stopped;
                            (true, format!("Stopped the API (process {pid})"))
                        }
                        Err(error) => (false, error),
                    });
                    cx.notify();
                });
            })
            .detach();
            return;
        }
        match self.gateway.start() {
            Ok(()) => {
                self.health = Health::Starting;
                self.message = None;
            }
            Err(error) => self.message = Some((false, format!("Failed to start gateway: {error}"))),
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let cli = self.accounts.clone();
        cx.spawn(async move |this, cx| {
            let (overview, saved, missing, profiles) = cx.background_executor().spawn(async move { (cli.overview(), cli.list(), cli.secret_missing(), cli.profiles()) }).await;
            let _ = this.update(cx, |shell, cx| {
                if let Ok(profiles) = profiles {
                    shell.profiles = profiles;
                }
                if let Ok(missing) = missing {
                    shell.locked = missing;
                }
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

    fn add_api_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = self.selected_key_provider() else { return };
        self.add_api_key_for(provider, window, cx);
    }

    fn add_api_key_for(&mut self, provider: String, window: &mut Window, cx: &mut Context<Self>) {
        let key = self.api_key.read(cx).value().to_string();
        self.api_key.update(cx, |input, cx| input.set_value("", window, cx));
        self.run_command(cx, move |cli| cli.add_api_key(&provider, &key));
    }

    fn open_link(&mut self, url: &str) {
        self.message = match open_in_browser(url) {
            Ok(()) => Some((true, format!("Opened {url} in your browser. Create a key there and paste it here."))),
            Err(error) => Some((false, error)),
        };
    }

    fn key_page(&self, provider: &str) -> Option<String> {
        self.overview.iter().find(|row| row.id == provider && row.kind == "api-key").and_then(|row| row.url.clone())
    }

    fn live(&self, id: &str) -> Option<&ProviderStatus> {
        self.status.as_ref()?.providers.iter().find(|provider| provider.id == id)
    }
}

fn model_rank(status: &GatewayStatus, model: &str) -> (usize, usize) {
    if let Some(position) = status.auto_models.iter().position(|entry| entry == model) {
        return (0, position);
    }
    if status.unavailable_models.iter().any(|entry| entry.model == model) {
        return (3, 0);
    }
    match status.model_stats.iter().find(|stat| stat.model == model) {
        Some(stat) if stat.last_outcome == "success" => (1, stat.latency_ms.unwrap_or(u64::MAX) as usize),
        Some(_) => (3, 0),
        None => (2, 0),
    }
}

fn last_line(text: &str, fallback: &str) -> String {
    text.lines().rev().find(|line| !line.trim().is_empty() && !line.starts_with('$')).unwrap_or(fallback).trim().to_string()
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.running = self.gateway.is_running();
        self.compact = window.viewport_size().width < px(COMPACT_WIDTH);
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
                            .p(px(if self.compact { 16. } else { 24. }))
                            .flex()
                            .flex_col()
                            .gap_4()
                            .children(self.render_message())
                            .child(match self.page {
                                Page::Providers => self.render_providers(cx),
                                Page::Accounts => self.render_accounts(cx),
                                Page::Requests => self.render_requests(cx),
                                Page::Provider => self.render_provider_settings(window, cx),
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
            .w(px(if self.compact { 200. } else { 236. }))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .p_3()
            .bg(rgb(SIDEBAR))
            .child({
                let enabled = !self.busy && self.health != Health::Starting;
                let (label, name, tone) = match self.health {
                    Health::Starting => ("Starting…", IconName::Play, Tone::Outline),
                    Health::Online => ("Stop API", IconName::Square, Tone::Danger),
                    Health::Stopped if self.running => ("Stop API", IconName::Square, Tone::Danger),
                    Health::Stopped => ("Run API", IconName::Play, Tone::Primary),
                };
                button("gateway-toggle", label, Some(name), tone, enabled)
                    .w_full()
                    .h(px(40.))
                    .justify_center()
                    .when(enabled, |this| {
                        this.on_click(cx.listener(|shell, _, _, cx| {
                            shell.toggle_gateway(cx);
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
                let selected = self.page == Page::Provider && self.selected_provider.as_deref() == Some(row.id.as_str());
                let id = row.id.clone();
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
                    .when(selected, |this| this.bg(rgb(SURFACE)).border_1().border_color(rgb(BORDER)).shadow_sm().font_weight(FontWeight::MEDIUM))
                    .when(!selected, |this| this.hover(|style| style.bg(rgb(0xf1f2f4))))
                    .child(provider_mark(&row.id, 22.))
                    .child(div().flex_1().child(display_name(&row.id).to_string()))
                    .child(status_dot(state))
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(move |shell, _, _, cx| {
                        shell.selected_provider = Some(id.clone());
                        shell.page = Page::Provider;
                        shell.message = None;
                        cx.notify();
                    }))
            }))
    }

    fn page_title(&self) -> String {
        match (self.page, self.selected_provider.as_deref()) {
            (Page::Provider, Some(id)) => display_name(id).to_string(),
            (page, _) => page.title().to_string(),
        }
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
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(self.page_title()))
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
        let compact = self.compact;
        let columns: Vec<(&'static str, f32)> = if compact {
            vec![("Provider", 0.), ("Status", 150.)]
        } else {
            vec![("Provider", 0.), ("Type", 160.), ("Status", 170.)]
        };
        let active = self.overview.iter().filter(|row| activity(row, self.live(&row.id)) == Activity::Active).count();
        let rows = self.overview.iter().map(|row| {
            let live = self.live(&row.id);
            let state = activity(row, live);
            let tip: SharedString = detail(row, live).into();
            table_row()
                .child(
                    cell(0.)
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
                .when(!compact, |this| this.child(cell(160.).text_color(rgb(MUTED)).child(kind_label(&row.kind).to_string())))
                .child(
                    cell(if compact { 150. } else { 170. }).flex().child(
                        div()
                            .id(SharedString::from(format!("status-{}", row.id)))
                            .child(status_badge(state))
                            .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx)),
                    ),
                )
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
                muted("Check sign-ins opens the browser profile, which the running API is using. Stop the API to check sign-ins.").text_xs()
            }))
            .into_any_element()
    }

    fn render_provider_settings(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.selected_provider.as_ref().and_then(|id| self.overview.iter().find(|row| &row.id == id)).cloned() else {
            return card().p_6().child(muted("Pick a provider in the sidebar.")).into_any_element();
        };
        let live = self.live(&row.id);
        let state = activity(&row, live);
        let blocked = self.browser_blocked();

        let summary = card()
            .p_4()
            .flex()
            .items_center()
            .gap_3()
            .child(provider_mark(&row.id, 44.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(display_name(&row.id).to_string()))
                            .child(status_badge(state)),
                    )
                    .child(muted(format!("{} · {}", kind_label(&row.kind), row.id)).text_xs())
                    .child(muted(if state == Activity::NotConnected {
                        "No API key yet. Get a free key from the provider and paste it below.".to_string()
                    } else {
                        detail(&row, live)
                    })),
            )
            .children(row.url.clone().filter(|_| row.kind == "api-key").map(|url| {
                button("provider-get-key", "Get API key", Some(IconName::ExternalLink), if state == Activity::NotConnected { Tone::Primary } else { Tone::Outline }, true)
                    .on_click(cx.listener(move |shell, _, _, cx| {
                        shell.open_link(&url);
                        cx.notify();
                    }))
            }));

        let connection = card().p_4().flex().flex_col().gap_3().child(div().font_weight(FontWeight::SEMIBOLD).child("Connection"));
        let connection = match (row.kind.as_str(), row.url.clone()) {
            ("web", Some(url)) => {
                let open_url = url.clone();
                connection
                    .child(muted(format!("Messages are sent from your signed-in session on {}.", url.trim_start_matches("https://").trim_end_matches('/'))).text_xs())
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(button("provider-sign-in", "Sign in in the browser", Some(IconName::LogIn), Tone::Primary, !blocked).when(!blocked, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let url = open_url.clone();
                                    shell.run_command(cx, move |cli| cli.open_site(&url));
                                    cx.notify();
                                }))
                            }))
                            .child(button("provider-check", "Check sign-in", Some(IconName::RefreshCw), Tone::Outline, !blocked).when(!blocked, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let url = url.clone();
                                    shell.run_command(cx, move |cli| cli.check_site(&url));
                                    cx.notify();
                                }))
                            })),
                    )
            }
            ("api-key", _) => {
                let provider = row.id.clone();
                let keys: Vec<SavedAccount> = self.saved.iter().filter(|account| account.provider == row.id).cloned().collect();
                connection
                    .child(muted("Keys are checked against the provider and stored encrypted. An environment variable overrides saved keys.").text_xs())
                    .children(keys.into_iter().map(|account| {
                        let id = account.id.clone();
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .py_1()
                            .child(div().flex().items_center().gap_2().child(div().text_size(px(15.)).child(IconName::KeyRound)).child(account.email.clone()).child(muted(account.id.clone()).text_xs()))
                            .child(button(SharedString::from(format!("remove-key-{}", account.id)), "Remove", Some(IconName::Trash), Tone::Danger, !self.busy).when(!self.busy, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let id = id.clone();
                                    shell.run_command(cx, move |cli| cli.remove(&id));
                                    cx.notify();
                                }))
                            }))
                    }))
                    .child(Input::new(&self.api_key))
                    .child(div().flex().justify_end().child(button("provider-save-key", if self.busy { "Working…" } else { "Save key" }, Some(IconName::KeyRound), Tone::Primary, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(move |shell, _, window, cx| {
                            shell.add_api_key_for(provider.clone(), window, cx);
                            cx.notify();
                        }))
                    })))
            }
            _ => connection.child(muted(match row.fix.as_deref() {
                Some(fix) => format!("Connect it from a terminal: {fix}"),
                None => "Connected. Manage its accounts from a terminal.".to_string(),
            })),
        }
        .children((blocked && row.kind == "web").then(|| muted("Browser actions are paused while the API runs, because it uses the same browser profile.").text_xs()));

        let provider = row.id.clone();
        let auto = row.auto;
        let routing = card()
            .p_4()
            .flex()
            .items_center()
            .justify_between()
            .gap_4()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Use in auto"))
                    .child(muted("When off, model=auto skips this provider. Requests that name its models still work.").text_xs()),
            )
            .child(
                div()
                    .id("provider-auto")
                    .w(px(44.))
                    .h(px(24.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .px(px(3.))
                    .rounded_full()
                    .bg(rgb(if auto { PRIMARY } else { 0xd1d5db }))
                    .when(auto, |this| this.justify_end())
                    .when(self.busy, |this| this.opacity(0.5))
                    .when(!self.busy, |this| {
                        this.cursor_pointer().on_click(cx.listener(move |shell, _, _, cx| {
                            let provider = provider.clone();
                            shell.run_command(cx, move |cli| cli.set_auto(&provider, !auto));
                            cx.notify();
                        }))
                    })
                    .child(div().size(px(18.)).rounded_full().bg(rgb(SURFACE)).shadow_sm()),
            );

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(summary)
            .child(
                div()
                    .flex()
                    .items_start()
                    .when(self.compact, |this| this.flex_col().items_stretch())
                    .gap_4()
                    .child(connection.flex_1().min_w_0())
                    .child(div().flex_1().min_w_0().flex().flex_col().gap_4().child(routing)),
            )
            .child(self.render_provider_models(&row.id, row.auto))
            .into_any_element()
    }

    fn render_provider_models(&self, provider: &str, provider_auto: bool) -> Div {
        let heading = div().flex().items_center().justify_between().child(div().font_weight(FontWeight::SEMIBOLD).child("Models"));
        let Some(status) = &self.status else {
            return card().p_4().flex().flex_col().gap_2().child(heading).child(muted("Run the API to see this provider's models."));
        };
        let mut models: Vec<&str> = status.models.iter().filter(|model| model.provider == provider).map(|model| model.id.as_str()).collect();
        models.sort_by_key(|model| model_rank(status, model));
        let columns: Vec<(&'static str, f32)> = if self.compact {
            vec![("Model", 0.), ("Status", 140.)]
        } else {
            vec![("Model", 0.), ("First answer", 130.), ("In auto", 100.), ("Status", 150.)]
        };
        let rows = models.iter().take(100).map(|model| {
            let stat = status.model_stats.iter().find(|stat| stat.model == *model);
            let hidden = status.unavailable_models.iter().any(|entry| entry.model == *model);
            let (state, label) = if hidden {
                (Activity::Inactive, "Unavailable")
            } else {
                match stat.map(|stat| stat.last_outcome.as_str()) {
                    Some("success") => (Activity::Active, "Working"),
                    Some(_) => (Activity::Degraded, "Failing"),
                    None => (Activity::Unknown, "Not used yet"),
                }
            };
            let in_auto = provider_auto && status.auto_models.iter().any(|entry| entry == model);
            table_row()
                .child(cell(0.).child(model.to_string()))
                .when(!self.compact, |this| {
                    this.child(cell(130.).text_color(rgb(MUTED)).child(stat.and_then(|stat| stat.latency_ms).map(|ms| format!("{:.1} s", ms as f64 / 1000.)).unwrap_or_else(|| "—".into())))
                        .child(cell(100.).text_color(rgb(MUTED)).child(if in_auto { "Yes" } else { "—" }))
                })
                .child(cell(if self.compact { 140. } else { 150. }).flex().child(labeled_badge(state, label)))
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(heading.child(muted(format!("{} model{}", models.len(), if models.len() == 1 { "" } else { "s" })).text_xs()))
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(rows)
                    .children(models.is_empty().then(|| table_row().child(muted("No models listed for this provider")))),
            )
    }

    fn render_accounts(&self, cx: &mut Context<Self>) -> AnyElement {
        let compact = self.compact;
        let states = self.status.as_ref().map(|status| status.accounts.as_slice()).unwrap_or_default();
        let columns: Vec<(&'static str, f32)> = if compact {
            vec![("Account", 0.), ("Status", 150.), ("Action", 120.)]
        } else {
            vec![("Account", 0.), ("Provider", 140.), ("Status", 150.), ("Failures", 100.), ("Action", 120.)]
        };
        let saved_rows = self.saved.iter().map(|account| {
            let state = states.iter().find(|state| state.account_id == account.id && state.provider == account.provider);
            let (state_activity, state_label) = match state.map(|state| state.status.as_str()) {
                Some("healthy") => (Activity::Active, "Healthy".to_string()),
                Some("cooldown") => (Activity::Degraded, "Cooling down".to_string()),
                Some("quota_exhausted") => (Activity::Degraded, "Quota exhausted".to_string()),
                Some(other) => (Activity::Inactive, other.replace('_', " ")),
                None => (Activity::Unknown, "Saved".to_string()),
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
                .when(!compact, |this| this.child(cell(140.).text_color(rgb(MUTED)).child(display_name(&account.provider).to_string())))
                .child(cell(150.).flex().child(labeled_badge(state_activity, state_label)))
                .when(!compact, |this| {
                    this.child(cell(100.).text_color(rgb(MUTED)).child(state.map(|state| state.consecutive_failures.to_string()).unwrap_or_else(|| "—".into())))
                })
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
        let key_providers = self.key_providers();
        let selected = self.selected_key_provider();
        let provider_pills = key_providers.iter().map(|id| {
            let active = selected.as_deref() == Some(id.as_str());
            let value = id.clone();
            div()
                .id(SharedString::from(format!("key-provider-{id}")))
                .flex()
                .items_center()
                .gap_2()
                .h(px(32.))
                .px_2p5()
                .rounded_md()
                .border_1()
                .border_color(rgb(if active { PRIMARY } else { BORDER }))
                .bg(rgb(if active { PRIMARY_SOFT } else { SURFACE }))
                .text_sm()
                .cursor_pointer()
                .child(provider_mark(id, 20.))
                .child(display_name(id).to_string())
                .on_click(cx.listener(move |shell, _, _, cx| {
                    shell.key_provider = Some(value.clone());
                    cx.notify();
                }))
        });
        let can_save_key = !self.busy && selected.is_some();
        let blocked = self.browser_blocked();
        let add_card = card()
            .flex_1()
            .min_w_0()
            .p_4()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().flex().items_center().gap_2().child(div().text_size(px(18.)).child(IconName::Users)).child(div().font_weight(FontWeight::SEMIBOLD).child("Add account")))
            .child(muted("Each account is its own browser profile. Sign it in to Google once, then use “Sign in with Google” on every web chat. Requests rotate between signed-in accounts.").text_xs())
            .child(Input::new(&self.profile_name))
            .child(
                div().flex().justify_end().child(
                    button("add-profile", if self.busy { "Working…" } else { "Add account" }, Some(IconName::Users), Tone::Primary, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(|shell, _, window, cx| {
                            shell.add_profile(window, cx);
                            cx.notify();
                        }))
                    }),
                ),
            );
        let profile_cards = self.profiles.iter().map(|profile| {
            let signed = profile.chats.iter().filter(|chat| chat.signed_in == Some(true)).count();
            let all = profile.chats.len();
            let connect_id = profile.id.clone();
            let check_id = profile.id.clone();
            let remove_id = profile.id.clone();
            card()
                .w(px(if compact { 320. } else { 390. }))
                .flex_none()
                .p_4()
                .flex()
                .flex_col()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2p5()
                        .child(
                            div()
                                .size(px(34.))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .bg(rgb(PRIMARY_SOFT))
                                .text_color(rgb(PRIMARY))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(profile.label.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().font_weight(FontWeight::SEMIBOLD).child(profile.label.clone()))
                                .child(muted(format!("{signed} of {all} chats signed in")).text_xs()),
                        ),
                )
                .child(div().flex().flex_wrap().gap_2().children(profile.chats.iter().map(|chat| {
                    let state = match chat.signed_in {
                        Some(true) => Activity::Active,
                        Some(false) => Activity::Inactive,
                        None => Activity::Unknown,
                    };
                    div()
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .px_2()
                        .py_1()
                        .rounded_full()
                        .border_1()
                        .border_color(rgb(BORDER))
                        .text_xs()
                        .child(provider_mark(&chat.id, 18.))
                        .child(display_name(&chat.id).trim_end_matches(" Chat").to_string())
                        .child(status_dot(state))
                })))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(button(SharedString::from(format!("connect-{}", profile.id)), "Connect chats", Some(IconName::LogIn), if signed < all { Tone::Primary } else { Tone::Outline }, !blocked).when(!blocked, |this| {
                            this.on_click(cx.listener(move |shell, _, _, cx| {
                                let id = connect_id.clone();
                                shell.message = Some((true, "Sign in to Google and every chat tab in the opened window, then close it.".into()));
                                shell.run_command(cx, move |cli| cli.connect_profile(&id));
                                cx.notify();
                            }))
                        }))
                        .child(button(SharedString::from(format!("check-{}", profile.id)), "Check", Some(IconName::RefreshCw), Tone::Outline, !blocked).when(!blocked, |this| {
                            this.on_click(cx.listener(move |shell, _, _, cx| {
                                let id = check_id.clone();
                                shell.run_command(cx, move |cli| cli.check_profile(&id));
                                cx.notify();
                            }))
                        }))
                        .children((profile.id != "default").then(|| {
                            button(SharedString::from(format!("remove-profile-{}", profile.id)), "Remove", Some(IconName::Trash), Tone::Danger, !self.busy).when(!self.busy, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let id = remove_id.clone();
                                    shell.run_command(cx, move |cli| cli.remove_profile(&id));
                                    cx.notify();
                                }))
                            })
                        })),
                )
        });
        let key_card = card()
            .flex_1()
            .min_w_0()
            .p_4()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().flex().items_center().gap_2().child(div().text_size(px(18.)).child(IconName::KeyRound)).child(div().font_weight(FontWeight::SEMIBOLD).child("API keys")))
            .child(muted("Pick a provider. The key is checked and stored encrypted.").text_xs())
            .child(div().flex().flex_wrap().gap_2().children(provider_pills).children(key_providers.is_empty().then(|| muted("Loading providers…"))))
            .child(Input::new(&self.api_key))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .gap_2()
                    .children(selected.clone().and_then(|provider| self.key_page(&provider).map(|url| (provider, url))).map(|(provider, url)| {
                        button("get-key", format!("Get {} key", display_name(&provider)), Some(IconName::ExternalLink), Tone::Outline, true).on_click(cx.listener(move |shell, _, _, cx| {
                            shell.open_link(&url);
                            cx.notify();
                        }))
                    }))
                    .child(div().flex_1())
                    .child(
                        button("add-key", if self.busy { "Working…" } else { "Save key" }, Some(IconName::KeyRound), Tone::Primary, can_save_key).when(can_save_key, |this| {
                            this.on_click(cx.listener(|shell, _, window, cx| {
                                shell.add_api_key(window, cx);
                                cx.notify();
                            }))
                        }),
                    ),
            );
        let total = self.saved.len();
        div()
            .flex()
            .flex_col()
            .gap_4()
            .children(self.registry_locked().then(|| {
                card()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .p_4()
                    .bg(rgb(0xfffbeb))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child("Accounts are locked"))
                            .child(muted("Create an encryption secret in the system keyring so API keys and accounts can be saved. Restart the API afterwards.").text_xs()),
                    )
                    .child(button("init-secret", "Create secret", Some(IconName::KeyRound), Tone::Primary, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(|shell, _, _, cx| {
                            shell.run_command(cx, |cli| cli.init_secret());
                            cx.notify();
                        }))
                    }))
            }))
            .child(div().flex().when(compact, |this| this.flex_col()).gap_4().child(add_card).child(key_card))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().flex().items_center().justify_between().child(div().font_weight(FontWeight::SEMIBOLD).child("Browser accounts")).child(muted(format!("{} account{}", self.profiles.len(), if self.profiles.len() == 1 { "" } else { "s" })).text_xs()))
                    .child(div().flex().flex_wrap().gap_4().children(profile_cards))
                    .children(blocked.then(|| muted("Connecting and checking open the account's browser profile. Stop the API first, because it uses the same profiles.").text_xs())),
            )
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(saved_rows)
                    .children((total == 0).then(|| table_row().child(muted("No accounts yet")))),
            )
            .child(muted(format!("Showing {total} accounts")).text_xs())
            .into_any_element()
    }

    fn render_requests(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(status) = &self.status else {
            return card()
                .p_6()
                .flex()
                .flex_col()
                .items_center()
                .gap_2()
                .child(icon(IconName::Activity, GRAY))
                .child(muted("Start the API to see requests."))
                .into_any_element();
        };
        let compact = self.compact;
        let now = now_ms();
        let mut providers: Vec<(String, usize)> = Vec::new();
        for request in &status.requests {
            match providers.iter_mut().find(|(id, _)| *id == request.provider) {
                Some((_, count)) => *count += 1,
                None => providers.push((request.provider.clone(), 1)),
            }
        }
        let filter = self.request_filter.clone().filter(|id| providers.iter().any(|(provider, _)| provider == id));
        let pill = |id: Option<String>, label: String, count: usize, cx: &mut Context<Self>| {
            let active = filter == id;
            let key = id.clone().unwrap_or_else(|| "all".into());
            div()
                .id(SharedString::from(format!("filter-{key}")))
                .flex()
                .items_center()
                .gap_2()
                .h(px(32.))
                .px_2p5()
                .rounded_md()
                .border_1()
                .border_color(rgb(if active { PRIMARY } else { BORDER }))
                .bg(rgb(if active { PRIMARY_SOFT } else { SURFACE }))
                .text_sm()
                .cursor_pointer()
                .children(id.as_deref().map(|provider| provider_mark(provider, 20.)))
                .child(label)
                .child(div().text_xs().text_color(rgb(MUTED)).child(count.to_string()))
                .on_click(cx.listener(move |shell, _, _, cx| {
                    shell.request_filter = id.clone();
                    cx.notify();
                }))
        };
        let pills: Vec<_> = std::iter::once(pill(None, "All".into(), status.requests.len(), cx))
            .chain(providers.iter().map(|(id, count)| pill(Some(id.clone()), display_name(id).to_string(), *count, cx)))
            .collect();
        let visible: Vec<_> = status.requests.iter().filter(|request| filter.as_deref().is_none_or(|id| request.provider == id)).take(50).collect();
        let columns: Vec<(&'static str, f32)> = if compact {
            vec![("Time", 90.), ("Model", 0.), ("Status", 120.)]
        } else {
            vec![("Time", 110.), ("Provider", 150.), ("Model", 0.), ("Latency", 100.), ("Status", 130.)]
        };
        let rows = visible.iter().map(|request| {
            let ok = request.status == "success";
            table_row()
                .child(cell(if compact { 90. } else { 110. }).text_color(rgb(MUTED)).child(relative_time(request.created_at, now)))
                .when(!compact, |this| {
                    this.child(cell(150.).flex().items_center().gap_2().child(provider_mark(&request.provider, 20.)).child(display_name(&request.provider).to_string()))
                })
                .child(
                    cell(0.)
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .when(compact, |this| this.child(provider_mark(&request.provider, 18.)))
                                .child(request.model.clone()),
                        )
                        .children(request.error.clone().map(|error| div().text_xs().text_color(rgb(RED)).child(error.chars().take(120).collect::<String>()))),
                )
                .when(!compact, |this| {
                    this.child(cell(100.).text_color(rgb(MUTED)).child(request.latency_ms.map(|latency| format!("{latency} ms")).unwrap_or_else(|| "—".into())))
                })
                .child(cell(if compact { 120. } else { 130. }).flex().child(labeled_badge(if ok { Activity::Active } else { Activity::Inactive }, if ok { "Success" } else { "Failed" })))
        });
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(div().flex().flex_wrap().gap_2().children(pills))
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(rows)
                    .children(visible.is_empty().then(|| table_row().child(muted("No requests yet")))),
            )
            .child(muted(format!("Showing {} requests", visible.len())).text_xs())
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
