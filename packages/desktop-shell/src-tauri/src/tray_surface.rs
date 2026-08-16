use std::sync::{Arc, Mutex};

use crate::shell_bridge::{ShellStateDto, ShellStateEmitter};
use crate::tray_lifecycle::{tray_gateway_label, tray_gateway_tooltip, TrayGatewayState};

/// The single application-wide tray icon id. Exactly one tray is ever built;
/// repeated Close/Show cycles never rebuild it, so no tray icon or menu
/// subscription is ever duplicated.
pub(crate) const TRAY_ID: &str = "luckytoken-main";

/// Stable public menu item ids. Menu event dispatch matches on these ids,
/// never on item positions.
pub(crate) const TRAY_SHOW_ID: &str = "tray-show";
pub(crate) const TRAY_QUIT_ID: &str = "tray-quit";

/// Projects the bridge shell state onto the sanitized tray surface. The tray
/// sees only the high-level gateway lifecycle; secrets, descriptors, and
/// transport details never enter tray text.
pub(crate) fn project_gateway_state(state: &ShellStateDto) -> TrayGatewayState {
    match state {
        ShellStateDto::Connected { snapshot, .. } => TrayGatewayState::from(snapshot.as_ref()),
        _ => TrayGatewayState::new(),
    }
}

/// Owns the tray surface for the application lifetime: one tray icon, one
/// menu, and one state projection.
pub(crate) struct TraySurface {
    gateway_state: Mutex<TrayGatewayState>,
}

impl TraySurface {
    pub(crate) fn new() -> Self {
        Self {
            gateway_state: Mutex::new(TrayGatewayState::new()),
        }
    }

    pub(crate) fn set_gateway_state(&self, gateway: TrayGatewayState) {
        *self.gateway_state.lock().unwrap() = gateway;
    }

    pub(crate) fn current_label(&self) -> String {
        tray_gateway_label(&self.gateway_state.lock().unwrap())
    }
}

/// Adapts the bridge event stream to the tray surface: updates the disabled
/// status menu item and the tooltip from the sanitized projection.
pub(crate) struct TrayStateEmitter {
    surface: Arc<TraySurface>,
    label: tauri::menu::MenuItem<tauri::Wry>,
    tray: tauri::tray::TrayIcon<tauri::Wry>,
}

impl TrayStateEmitter {
    pub(crate) fn new(
        surface: Arc<TraySurface>,
        label: tauri::menu::MenuItem<tauri::Wry>,
        tray: tauri::tray::TrayIcon<tauri::Wry>,
    ) -> Self {
        Self {
            surface,
            label,
            tray,
        }
    }
}

impl ShellStateEmitter for TrayStateEmitter {
    fn emit(&self, state: &ShellStateDto) {
        let gateway = project_gateway_state(state);
        self.surface.set_gateway_state(gateway.clone());
        let _ = self.label.set_text(tray_gateway_label(&gateway));
        let _ = self.tray.set_tooltip(Some(tray_gateway_tooltip(&gateway)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane_v1::{
        DataPlaneStatus, ModelDataPlaneState, ProviderState, StatusSnapshot,
    };

    #[test]
    fn connected_state_projects_only_high_level_gateway_facts() {
        let state = ShellStateDto::Connected {
            revision: 2,
            application_version: "native-test".to_owned(),
            contract_version: 1,
            snapshot: Box::new(StatusSnapshot {
                sequence: 2,
                model_data_plane: ModelDataPlaneState::Running,
                provider: ProviderState::Configured,
                data_plane: Some(DataPlaneStatus {
                    configured_origin: "http://127.0.0.1:3000".to_owned(),
                    configured_port: 3000,
                    failure: None,
                }),
                settings: None,
                confirmation: None,
                ownership: None,

                models: None,
                aliases: None,
                credentials: None,
            }),
            models: None,
        };

        let gateway = project_gateway_state(&state);
        assert_eq!(gateway.model_data_plane, ModelDataPlaneState::Running);
        assert_eq!(gateway.provider, ProviderState::Configured);
        let label = tray_gateway_label(&gateway);
        assert_eq!(label, "LuckyToken — Gateway running");
        assert!(
            !label.contains("3000"),
            "origin must never reach the tray label"
        );
    }

    #[test]
    fn disconnected_and_unavailable_states_reset_to_a_secret_free_default() {
        for state in [
            ShellStateDto::Unavailable {
                revision: 3,
                reason: crate::shell_bridge::UnavailableReason::DescriptorMissing,
            },
            ShellStateDto::Disconnected {
                revision: 3,
                reason: crate::shell_bridge::DisconnectReason::TransportLost,
            },
        ] {
            let gateway = project_gateway_state(&state);
            assert_eq!(gateway, TrayGatewayState::new());
            assert_eq!(
                tray_gateway_label(&gateway),
                "LuckyToken — Gateway stopped",
                "failed states must fall back to the fixed sanitized label"
            );
        }
    }
}
