use tauri::AppHandle;

use crate::control_plane_v1::{AttentionCategoryWire, AttentionConditionWire};
use crate::navigation::{show_and_navigate, NavigationPage};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NotificationContent {
    pub(crate) title: &'static str,
    pub(crate) body: &'static str,
    pub(crate) page: NavigationPage,
}

pub(crate) fn notification_content(category: AttentionCategoryWire) -> NotificationContent {
    match category {
        AttentionCategoryWire::GatewayStartFailed => NotificationContent {
            title: "LuckyToken gateway did not start",
            body: "Open Dashboard to review the gateway failure.",
            page: NavigationPage::Dashboard,
        },
        AttentionCategoryWire::PortConflict => NotificationContent {
            title: "LuckyToken port is already in use",
            body: "Open Dashboard to choose a free fixed port.",
            page: NavigationPage::Dashboard,
        },
        AttentionCategoryWire::PersistenceCritical => NotificationContent {
            title: "LuckyToken audit storage is unavailable",
            body: "Open Diagnostics to review the critical persistence state.",
            page: NavigationPage::Diagnostics,
        },
        AttentionCategoryWire::ProviderLoginInvalid => NotificationContent {
            title: "LuckyToken Provider login needs attention",
            body: "Open Providers to sign in again.",
            page: NavigationPage::Providers,
        },
    }
}

pub(crate) trait AttentionNotificationSink: Send + Sync {
    fn notify(&self, condition: &AttentionConditionWire);
}

pub(crate) struct WindowsNotificationSink {
    app: AppHandle,
}

impl WindowsNotificationSink {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(target_os = "windows")]
fn show_windows_toast(app_id: &str, app: &AppHandle, content: NotificationContent) -> bool {
    use tauri_winrt_notification::Toast;

    let activation_app = app.clone();
    Toast::new(app_id)
        .title(content.title)
        .text1(content.body)
        .add_button("Open LuckyToken", content.page.as_str())
        .on_activated(move |action| {
            let page = action
                .as_deref()
                .and_then(NavigationPage::from_action)
                .unwrap_or(content.page);
            show_and_navigate(&activation_app, page);
            Ok(())
        })
        .show()
        .is_ok()
}

impl AttentionNotificationSink for WindowsNotificationSink {
    fn notify(&self, condition: &AttentionConditionWire) {
        let content = notification_content(condition.category);
        #[cfg(target_os = "windows")]
        {
            // Installed NSIS builds register the product AUMID. The fallback
            // keeps the unpackaged release smoke functional without changing
            // notification policy or content.
            if !show_windows_toast("com.luckytoken.desktop", &self.app, content) {
                let _ = show_windows_toast(
                    tauri_winrt_notification::Toast::POWERSHELL_APP_ID,
                    &self.app,
                    content,
                );
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (&self.app, content);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_actionable_categories_have_fixed_secret_free_copy_and_navigation() {
        let cases = [
            (
                AttentionCategoryWire::GatewayStartFailed,
                NavigationPage::Dashboard,
            ),
            (
                AttentionCategoryWire::PortConflict,
                NavigationPage::Dashboard,
            ),
            (
                AttentionCategoryWire::PersistenceCritical,
                NavigationPage::Diagnostics,
            ),
            (
                AttentionCategoryWire::ProviderLoginInvalid,
                NavigationPage::Providers,
            ),
        ];
        for (category, page) in cases {
            let content = notification_content(category);
            assert_eq!(content.page, page);
            let serialized = format!("{} {}", content.title, content.body);
            assert!(!serialized.contains("provider-secret"));
            assert!(!serialized.contains("real-model-secret"));
            assert!(!serialized.contains("request-secret"));
        }
    }
}
