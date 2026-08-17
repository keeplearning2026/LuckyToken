use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const NAVIGATE_EVENT: &str = "luckytoken://navigate";
pub(crate) const TRAY_DASHBOARD_ID: &str = "tray-open-dashboard";
pub(crate) const TRAY_PROVIDERS_ID: &str = "tray-open-providers";
pub(crate) const TRAY_REQUESTS_ID: &str = "tray-open-requests";
pub(crate) const TRAY_DIAGNOSTICS_ID: &str = "tray-open-diagnostics";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NavigationPage {
    Dashboard,
    Providers,
    Requests,
    Diagnostics,
}

impl NavigationPage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Dashboard => "dashboard",
            Self::Providers => "providers",
            Self::Requests => "requests",
            Self::Diagnostics => "diagnostics",
        }
    }

    pub(crate) fn from_action(value: &str) -> Option<Self> {
        match value {
            "dashboard" => Some(Self::Dashboard),
            "providers" => Some(Self::Providers),
            "requests" => Some(Self::Requests),
            "diagnostics" => Some(Self::Diagnostics),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
struct NavigationPayload {
    page: &'static str,
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn show_and_navigate(app: &AppHandle, page: NavigationPage) {
    show_main_window(app);
    let _ = app.emit_to(
        "main",
        NAVIGATE_EVENT,
        NavigationPayload {
            page: page.as_str(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_actions_are_an_exact_allowlist() {
        assert_eq!(
            NavigationPage::from_action("requests"),
            Some(NavigationPage::Requests)
        );
        assert_eq!(NavigationPage::from_action("credentials"), None);
        assert_eq!(NavigationPage::from_action("requests?token=secret"), None);
    }
}
