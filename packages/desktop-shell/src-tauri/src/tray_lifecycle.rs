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
    /// Ticket 23: fixed degraded flag projected from the audit-unavailable
    /// status projection; only a fixed label variant may leave this module.
    pub(crate) audit_unavailable: bool,
    /// Ticket 25: aggregate count only. Request ids, bodies, aliases and
    /// model/provider identifiers never enter the tray state.
    pub(crate) recent_request_failures: u64,
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
            audit_unavailable: snapshot.persistence.is_some(),
            recent_request_failures: snapshot
                .attention
                .as_ref()
                .and_then(|attention| attention.request_failures.as_ref())
                .map_or(0, |aggregate| aggregate.count),
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
            audit_unavailable: false,
            recent_request_failures: 0,
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

/// Tray status line: high-level lifecycle only, plus the fixed degraded
/// suffix while the audit-unavailable projection is present. The configured
/// origin and port never appear in tray text, so no secret can leak through
/// the tray surface.
pub(crate) fn tray_gateway_label(gateway: &TrayGatewayState) -> String {
    let failures = if gateway.recent_request_failures == 0 {
        String::new()
    } else {
        format!(
            " · {} recent failure{}",
            gateway.recent_request_failures,
            if gateway.recent_request_failures == 1 {
                ""
            } else {
                "s"
            }
        )
    };
    format!(
        "LuckyToken — Gateway {}{}{}",
        gateway_state_label(gateway.model_data_plane),
        if gateway.audit_unavailable {
            " (audit unavailable)"
        } else {
            ""
        },
        failures,
    )
}

/// Tray tooltip: high-level lifecycle and provider configuration only.
pub(crate) fn tray_gateway_tooltip(gateway: &TrayGatewayState) -> String {
    let failures = if gateway.recent_request_failures == 0 {
        String::new()
    } else {
        format!(
            "; {} recent request failures",
            gateway.recent_request_failures
        )
    };
    format!(
        "LuckyToken {} (gateway {}{}{})",
        gateway_state_label(gateway.model_data_plane),
        provider_state_label(gateway.provider),
        if gateway.audit_unavailable {
            "; audit unavailable"
        } else {
            ""
        },
        failures,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane_v1::{
        DataPlaneStatus, ModelDataPlaneState, PersistenceAuthorityProjectionWire,
        PersistenceProjectionWire, ProviderState,
    };

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
            ownership: None,

            models: None,
            aliases: None,
            credentials: None,
            persistence: None,
            recovery: None,
            attention: None,
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
    fn tray_gateway_label_shows_the_fixed_audit_unavailable_variant() {
        let mut snapshot = running_snapshot_with_origin();
        snapshot.persistence = Some(PersistenceProjectionWire {
            audit_unavailable: true,
            acknowledged: false,
            authorities: vec![PersistenceAuthorityProjectionWire {
                authority: "requestLedger".to_owned(),
                since: 1_700_000_000_000,
            }],
        });
        let gateway = TrayGatewayState::from(&snapshot);
        assert_eq!(
            tray_gateway_label(&gateway),
            "LuckyToken — Gateway running (audit unavailable)"
        );
        assert_eq!(
            tray_gateway_tooltip(&gateway),
            "LuckyToken running (gateway configured; audit unavailable)"
        );
        // Acknowledgment silences urgency in the UI but never changes the
        // tray's fixed degraded variant: the projection is still present.
        snapshot.persistence.as_mut().unwrap().acknowledged = true;
        let gateway = TrayGatewayState::from(&snapshot);
        assert_eq!(
            tray_gateway_label(&gateway),
            "LuckyToken — Gateway running (audit unavailable)"
        );
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

    #[test]
    fn tray_label_shows_only_the_recent_failure_count() {
        let mut snapshot = running_snapshot_with_origin();
        snapshot.attention = Some(crate::control_plane_v1::AttentionProjectionWire {
            conditions: vec![],
            request_failures: Some(crate::control_plane_v1::RecentRequestFailuresWire {
                count: 3,
                window_ms: 3_600_000,
            }),
        });
        let gateway = TrayGatewayState::from(&snapshot);
        assert_eq!(
            tray_gateway_label(&gateway),
            "LuckyToken — Gateway running · 3 recent failures"
        );
        assert!(!tray_gateway_label(&gateway).contains("request-secret"));
        assert!(!tray_gateway_tooltip(&gateway).contains("real-model-secret"));
    }
}
