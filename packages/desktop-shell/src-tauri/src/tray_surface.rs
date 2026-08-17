use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::control_plane_v1::AttentionConditionWire;
use crate::notification::AttentionNotificationSink;
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
    notifications: Arc<dyn AttentionNotificationSink>,
    attention: Mutex<AttentionActivationTracker>,
}

#[derive(Default)]
struct AttentionActivationTracker {
    baseline_established: bool,
    active_ids: HashSet<String>,
}

impl AttentionActivationTracker {
    fn observe(&mut self, state: &ShellStateDto) -> Vec<AttentionConditionWire> {
        let ShellStateDto::Connected { snapshot, .. } = state else {
            self.baseline_established = false;
            self.active_ids.clear();
            return Vec::new();
        };
        let conditions = snapshot
            .attention
            .as_ref()
            .map_or(&[][..], |attention| attention.conditions.as_slice());
        let next_ids: HashSet<String> = conditions
            .iter()
            .map(|condition| condition.id.clone())
            .collect();
        if !self.baseline_established {
            self.baseline_established = true;
            self.active_ids = next_ids;
            return Vec::new();
        }
        let activations = conditions
            .iter()
            .filter(|condition| !self.active_ids.contains(&condition.id))
            .cloned()
            .collect();
        self.active_ids = next_ids;
        activations
    }
}

impl TrayStateEmitter {
    pub(crate) fn new(
        surface: Arc<TraySurface>,
        label: tauri::menu::MenuItem<tauri::Wry>,
        tray: tauri::tray::TrayIcon<tauri::Wry>,
        notifications: Arc<dyn AttentionNotificationSink>,
    ) -> Self {
        Self {
            surface,
            label,
            tray,
            notifications,
            attention: Mutex::new(AttentionActivationTracker::default()),
        }
    }
}

impl ShellStateEmitter for TrayStateEmitter {
    fn emit(&self, state: &ShellStateDto) {
        for condition in self.attention.lock().unwrap().observe(state) {
            self.notifications.notify(&condition);
        }
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
        AttentionCategoryWire, AttentionConditionWire, AttentionPageWire, AttentionProjectionWire,
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
                persistence: None,
                recovery: None,
                attention: None,
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

    fn connected_with_conditions(
        revision: u64,
        conditions: Vec<AttentionConditionWire>,
    ) -> ShellStateDto {
        ShellStateDto::Connected {
            revision,
            application_version: "native-test".to_owned(),
            contract_version: 1,
            snapshot: Box::new(StatusSnapshot {
                sequence: revision,
                model_data_plane: ModelDataPlaneState::Running,
                provider: ProviderState::Configured,
                data_plane: None,
                settings: None,
                confirmation: None,
                ownership: None,
                models: None,
                aliases: None,
                credentials: None,
                persistence: None,
                recovery: None,
                attention: Some(AttentionProjectionWire {
                    conditions,
                    request_failures: None,
                }),
            }),
            models: None,
        }
    }

    fn port_conflict() -> AttentionConditionWire {
        AttentionConditionWire {
            id: "port-conflict".to_owned(),
            category: AttentionCategoryWire::PortConflict,
            since: 1,
            page: AttentionPageWire::Dashboard,
            provider_id: None,
        }
    }

    #[test]
    fn attention_tracker_baselines_attach_coalesces_and_reactivates_after_recovery() {
        let mut tracker = AttentionActivationTracker::default();
        assert!(tracker
            .observe(&connected_with_conditions(1, vec![port_conflict()]))
            .is_empty());
        assert!(tracker
            .observe(&connected_with_conditions(2, vec![port_conflict()]))
            .is_empty());
        assert!(tracker
            .observe(&connected_with_conditions(3, vec![]))
            .is_empty());
        let activated = tracker.observe(&connected_with_conditions(4, vec![port_conflict()]));
        assert_eq!(activated.len(), 1);
        assert_eq!(activated[0].category, AttentionCategoryWire::PortConflict);
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
