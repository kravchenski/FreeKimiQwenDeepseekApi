use gpui_kit::assets::IconName;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use std::sync::atomic::{AtomicBool, Ordering};

use crate::assets::logo_path;
use crate::overview::Activity;

pub const CANVAS: u32 = 0xf3f4f6;
pub const SURFACE: u32 = 0xffffff;
pub const SIDEBAR: u32 = 0xf9fafb;
pub const BORDER: u32 = 0xe5e7eb;
pub const HEADER_ROW: u32 = 0xf9fafb;
pub const TEXT: u32 = 0x111827;
pub const MUTED: u32 = 0x6b7280;
pub const PRIMARY: u32 = 0x1f7a4d;
pub const PRIMARY_SOFT: u32 = 0xe8f3ee;
pub const GREEN: u32 = 0x16a34a;
pub const AMBER: u32 = 0xd97706;
pub const RED: u32 = 0xdc2626;
pub const GRAY: u32 = 0x9ca3af;

pub const HOVER: u32 = 0xf1f2f4;
pub const WARNING_SOFT: u32 = 0xfffbeb;
pub const DANGER_SOFT: u32 = 0xfef2f2;
pub const SWITCH_OFF: u32 = 0xd1d5db;
const WHITE: u32 = 0xffffff;

static DARK: AtomicBool = AtomicBool::new(false);

pub fn set_dark(dark: bool) {
    DARK.store(dark, Ordering::Relaxed);
}

pub fn is_dark() -> bool {
    DARK.load(Ordering::Relaxed)
}

fn dark_variant(hex: u32) -> u32 {
    match hex {
        SURFACE => 0x15181d,
        CANVAS => 0x0e1013,
        SIDEBAR => 0x111418,
        BORDER => 0x2a2f37,
        TEXT => 0xe6e8eb,
        MUTED => 0x9aa3ad,
        PRIMARY => 0x2f9e67,
        PRIMARY_SOFT => 0x14301f,
        HOVER => 0x1d2127,
        WARNING_SOFT => 0x2b2512,
        DANGER_SOFT => 0x2e1618,
        SWITCH_OFF => 0x3b414a,
        other => other,
    }
}

pub fn col(hex: u32) -> Rgba {
    rgb(if is_dark() { dark_variant(hex) } else { hex })
}

pub fn activity_color(activity: Activity) -> u32 {
    match activity {
        Activity::Active => GREEN,
        Activity::Degraded => AMBER,
        Activity::Inactive => RED,
        Activity::Unknown | Activity::NotConnected => GRAY,
    }
}

pub fn provider_mark(id: &str, size: f32) -> Div {
    let frame = div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(size * 0.28))
        .border_1()
        .border_color(col(BORDER))
        .bg(rgb(WHITE));
    match logo_path(id) {
        Some(path) => frame.child(img(path).size(px(size * 0.62))),
        None => frame.text_color(col(MUTED)).text_size(px(size * 0.45)).child("?"),
    }
}

pub fn status_dot(activity: Activity) -> Div {
    div().size(px(8.)).flex_none().rounded_full().bg(col(activity_color(activity)))
}

pub fn status_badge(activity: Activity) -> Div {
    labeled_badge(activity, activity.label())
}

pub fn labeled_badge(activity: Activity, label: impl Into<SharedString>) -> Div {
    let color = activity_color(activity);
    div()
        .flex()
        .items_center()
        .gap_1p5()
        .px_2()
        .py_0p5()
        .rounded_full()
        .border_1()
        .border_color(col(BORDER))
        .text_xs()
        .text_color(col(TEXT))
        .child(div().size(px(7.)).rounded_full().bg(col(color)))
        .child(label.into())
}

pub fn card() -> Div {
    div().rounded_lg().border_1().border_color(col(BORDER)).bg(col(SURFACE))
}

pub fn table_header(columns: &[(&'static str, f32)]) -> Div {
    div()
        .flex()
        .items_center()
        .h(px(38.))
        .px_4()
        .bg(col(HEADER_ROW))
        .border_b_1()
        .border_color(col(BORDER))
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(col(MUTED))
        .children(columns.iter().map(|(title, width)| cell(*width).child(*title)))
}

pub fn table_row() -> Div {
    div()
        .flex()
        .items_center()
        .min_h(px(52.))
        .px_4()
        .border_b_1()
        .border_color(col(BORDER))
        .text_sm()
        .text_color(col(TEXT))
}

pub fn cell(width: f32) -> Div {
    if width > 0. {
        div().w(px(width)).flex_none().pr_3().overflow_hidden()
    } else {
        div().flex_1().min_w_0().pr_3().overflow_hidden()
    }
}

pub fn muted(text: impl Into<SharedString>) -> Div {
    div().text_sm().text_color(col(MUTED)).child(text.into())
}

pub fn icon(name: IconName, color: u32) -> Div {
    div().flex_none().text_color(col(color)).text_size(px(16.)).child(name)
}

pub enum Tone {
    Primary,
    Outline,
    Danger,
}

pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>, leading: Option<IconName>, tone: Tone, enabled: bool) -> Stateful<Div> {
    let (bg, fg, border) = match tone {
        Tone::Primary => (PRIMARY, WHITE, PRIMARY),
        Tone::Outline => (SURFACE, TEXT, BORDER),
        Tone::Danger => (SURFACE, RED, BORDER),
    };
    div()
        .id(id.into())
        .flex()
        .flex_none()
        .items_center()
        .gap_2()
        .h(px(34.))
        .px_3()
        .rounded_md()
        .border_1()
        .border_color(col(border))
        .bg(col(bg))
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .text_color(col(fg))
        .when(!enabled, |this| this.opacity(0.45))
        .when(enabled, |this| this.cursor_pointer().hover(|style| style.opacity(0.85)))
        .children(leading.map(|name| div().text_size(px(15.)).child(name)))
        .child(label.into())
}

pub fn nav_item(id: impl Into<ElementId>, name: IconName, label: &'static str, selected: bool) -> Stateful<Div> {
    div()
        .id(id.into())
        .flex()
        .items_center()
        .gap_2p5()
        .h(px(34.))
        .px_2p5()
        .rounded_md()
        .text_sm()
        .cursor_pointer()
        .text_color(col(if selected { TEXT } else { MUTED }))
        .when(selected, |this| this.bg(col(SURFACE)).border_1().border_color(col(BORDER)).shadow_sm().font_weight(FontWeight::MEDIUM))
        .when(!selected, |this| this.hover(|style| style.bg(col(HOVER))))
        .child(div().text_size(px(16.)).child(name))
        .child(label)
}

pub fn nav_heading(label: &'static str) -> Div {
    div().px_2p5().pt_4().pb_1().text_xs().font_weight(FontWeight::MEDIUM).text_color(col(TEXT)).child(label)
}
