use crate::control_plane_v1::{ModelDataPlaneState, ProviderState, StatusSnapshot};

/// Sanitized high-level gateway state shown by the tray. The tray menu never
/// reveals credentials, model secrets, the descriptor, pipe names, or
/// transport internals: only lifecycle labels derived from the public status
/// snapshot may leave this module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TrayGatewayState {
    pub(crate) model_data_plane: ModelDataPlaneState,
    pub(crate) provider: ProviderState,
    configured_origin: Option<String>,
    configured_port: Option<u16>,
}

impl From<&StatusSnapshot> for TrayGatewayState {
    fn from(snapshot: &StatusSnapshot) -> Self {
        Self {
            model_data_plane: snapshot.model_data_plane,
            provider: snapshot.provider,
            configured_origin: snapshot
                .data_plane
                .as_ref()
                .map(|data_plane| data_plane.configured_origin.clone()),
            configured_port: snapshot
                .data_plane
                .as_ref()
                .map(|data_plane| data_plane.configured_port),
        }
    }
}

impl TrayGatewayState {
    pub(crate) fn new() -> Self {
        Self {
            model_data_plane: ModelDataPlaneState::Stopped,
            provider: ProviderState::Unconfigured,
            configured_origin: None,
            configured_port: None,
        }
    }
}

fn gateway_state_label(state: ModelDataPlaneState) -> &'static str {
    match state {
        ModelDataPlaneState::Running => "running",
        ModelDataPlaneState::Stopped => "stopped",
        ModelDataPlaneState::Starting => "starting",
        ModelDataPlaneState::Stopping => "stopping",
        ModelDataPlaneState::Failed => "failed",
    }
}

fn provider_state_label(state: ProviderState) -> &'static str {
    match state {
        ProviderState::Configured => "configured",
        ProviderState::Unconfigured => "unconfigured",
    }
}

/// Tray status line: high-level lifecycle only. The configured origin and port
/// never appear in tray text, so no secret can leak through the tray surface.
pub(crate) fn tray_gateway_label(gateway: &TrayGatewayState) -> String {
    format!(
        "LuckyToken — Gateway {}",
        gateway_state_label(gateway.model_data_plane)
    )
}

/// Tray tooltip: high-level lifecycle and provider configuration only.
pub(crate) fn tray_gateway_tooltip(gateway: &TrayGatewayState) -> String {
    format!(
        "LuckyToken {} (gateway {})",
        gateway_state_label(gateway.model_data_plane),
        provider_state_label(gateway.provider),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane_v1::{DataPlaneStatus, ModelDataPlaneState, ProviderState};

    fn running_snapshot_with_origin() -> StatusSnapshot {
        StatusSnapshot {
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
        }
    }

    #[test]
    fn tray_gateway_label_is_high_level_and_secret_free() {
        let gateway = TrayGatewayState::from(&running_snapshot_with_origin());
        assert_eq!(tray_gateway_label(&gateway), "LuckyToken — Gateway running");
        assert!(
            !tray_gateway_label(&gateway).contains("3000"),
            "tray label must not reveal the origin or port"
        );
    }

    #[test]
    fn tray_gateway_tooltip_is_high_level_and_secret_free() {
        let gateway = TrayGatewayState::from(&running_snapshot_with_origin());
        assert_eq!(
            tray_gateway_tooltip(&gateway),
            "LuckyToken running (gateway configured)"
        );
        assert!(
            !tray_gateway_tooltip(&gateway).contains("3000"),
            "tray tooltip must not reveal the origin or port"
        );
        assert!(
            !tray_gateway_tooltip(&gateway).contains("127.0.0.1"),
            "tray tooltip must not reveal the origin host"
        );
    }
}
