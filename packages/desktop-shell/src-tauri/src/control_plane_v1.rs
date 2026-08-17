use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{split, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    sync::{oneshot, Notify},
};

use crate::native_discovery::{DiscoveryFailure, NativeControlPlaneDiscovery};

pub(crate) const CONTROL_PLANE_VERSION: u64 = 1;
const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConnectionFailure {
    DescriptorMissing,
    DescriptorInvalid,
    PipeUnavailable,
    ProtocolError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionFailure {
    TransportLost,
    ProtocolError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelDataPlaneState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderState {
    Configured,
    Unconfigured,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DataPlaneFailureCode {
    PortInUse,
    StartFailed,
    StopFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct DataPlaneFailure {
    pub(crate) code: DataPlaneFailureCode,
    pub(crate) message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct DataPlaneStatus {
    #[serde(rename = "configuredOrigin")]
    pub(crate) configured_origin: String,
    #[serde(rename = "configuredPort")]
    pub(crate) configured_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) failure: Option<DataPlaneFailure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OwnerKind {
    Cli,
    Desktop,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct OwnerWire {
    pub(crate) kind: OwnerKind,
    pub(crate) pid: u64,
    #[serde(rename = "startedAt")]
    pub(crate) started_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct OwnershipWire {
    pub(crate) owner: OwnerWire,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct RegisteredSettingWire {
    pub(crate) key: String,
    pub(crate) r#type: String,
    pub(crate) default: Value,
    pub(crate) validation: Value,
    pub(crate) sensitivity: String,
    #[serde(rename = "applyMode")]
    pub(crate) apply_mode: String,
    pub(crate) value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) effective: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct LanConfirmationWire {
    #[serde(rename = "actionId")]
    pub(crate) action_id: String,
    #[serde(rename = "settingKey")]
    pub(crate) setting_key: String,
    pub(crate) value: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct StatusSnapshot {
    pub(crate) sequence: u64,
    #[serde(rename = "modelDataPlane")]
    pub(crate) model_data_plane: ModelDataPlaneState,
    pub(crate) provider: ProviderState,
    #[serde(rename = "dataPlane", skip_serializing_if = "Option::is_none")]
    pub(crate) data_plane: Option<DataPlaneStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) settings: Option<BTreeMap<String, RegisteredSettingWire>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) confirmation: Option<LanConfirmationWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ownership: Option<OwnershipWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) models: Option<ModelsProjectionWire>,
    #[serde(rename = "aliases", skip_serializing_if = "Option::is_none")]
    pub(crate) aliases: Option<AliasesProjectionWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credentials: Option<CredentialProjectionWire>,
    /// Ticket 23: present while at least one history persistence authority is
    /// unavailable; the tray renders a fixed degraded label from this flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) persistence: Option<PersistenceProjectionWire>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeCommand {
    Start,
    Stop,
    Restart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SettingsCommand {
    Query,
    Set,
    Confirm,
}

impl SettingsCommand {
    fn as_str(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Set => "set",
            Self::Confirm => "confirm",
        }
    }

    fn request_id(self) -> &'static str {
        match self {
            Self::Query => "desktop-settings-query",
            Self::Set => "desktop-settings-set",
            Self::Confirm => "desktop-settings-confirm",
        }
    }
}

/// Ticket 23 History commands. Rust owns only the allowlisted transport
/// shape; range, confirmation, export and deletion semantics remain in the
/// TypeScript History Authority.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum HistoryCommand {
    Query { range: Option<Value> },
    Export { command: Value },
    ExportConfirm { action_id: String },
    Delete { command: Value },
    DeleteConfirm { action_id: String },
}

impl HistoryCommand {
    pub(crate) fn query(range: Option<Value>) -> Option<Self> {
        let range = match range {
            Some(raw) => {
                let decoded: HistoryRangeWire = serde_json::from_value(raw).ok()?;
                if !decoded.is_valid() {
                    return None;
                }
                Some(serde_json::to_value(decoded).ok()?)
            }
            None => None,
        };
        Some(Self::Query { range })
    }

    pub(crate) fn export(command: Value) -> Option<Self> {
        let decoded: HistoryExportCommandWire = serde_json::from_value(command).ok()?;
        if !decoded.is_valid() {
            return None;
        }
        Some(Self::Export {
            command: serde_json::to_value(decoded).ok()?,
        })
    }

    pub(crate) fn export_confirm(action_id: String) -> Option<Self> {
        (!action_id.is_empty()).then_some(Self::ExportConfirm { action_id })
    }

    pub(crate) fn delete(command: Value) -> Option<Self> {
        let decoded: HistoryDeleteCommandWire = serde_json::from_value(command).ok()?;
        if !decoded.range.is_valid() {
            return None;
        }
        Some(Self::Delete {
            command: serde_json::to_value(decoded).ok()?,
        })
    }

    pub(crate) fn delete_confirm(action_id: String) -> Option<Self> {
        (!action_id.is_empty()).then_some(Self::DeleteConfirm { action_id })
    }

    fn request_id(&self) -> &'static str {
        match self {
            Self::Query { .. } => "desktop-history-query",
            Self::Export { .. } => "desktop-history-export",
            Self::ExportConfirm { .. } => "desktop-history-export-confirm",
            Self::Delete { .. } => "desktop-history-delete",
            Self::DeleteConfirm { .. } => "desktop-history-delete-confirm",
        }
    }

    fn request(&self) -> Value {
        match self {
            Self::Query { range } => {
                let mut request = json!({
                    "type": "history_query",
                    "requestId": self.request_id(),
                });
                if let Some(range) = range {
                    request["range"] = range.clone();
                }
                request
            }
            Self::Export { command } => json!({
                "type": "history_export_command",
                "requestId": self.request_id(),
                "command": command,
            }),
            Self::ExportConfirm { action_id } => json!({
                "type": "history_export_confirm",
                "requestId": self.request_id(),
                "actionId": action_id,
            }),
            Self::Delete { command } => json!({
                "type": "history_delete_command",
                "requestId": self.request_id(),
                "command": command,
            }),
            Self::DeleteConfirm { action_id } => json!({
                "type": "history_delete_confirm",
                "requestId": self.request_id(),
                "actionId": action_id,
            }),
        }
    }

    fn response_type(&self) -> &'static str {
        match self {
            Self::Query { .. } => "history_query_result",
            Self::Export { .. } => "history_export_result",
            Self::ExportConfirm { .. } => "history_export_result",
            Self::Delete { .. } | Self::DeleteConfirm { .. } => "history_delete_result",
        }
    }
}

/// Versioned Client Token commands (Ticket 16 + Ticket 17 directory scopes):
/// the renderer manages the one live global token and one token per
/// canonical directory scope per enabled Client Protocol. Mutations carry
/// the expected revision from a prior list so a stale UI can never
/// overwrite a newer token. Project scope inputs are raw picker paths; the
/// backend canonicalizes them at the authority boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AutoStartAction {
    Status,
    Enable,
    Disable,
}

impl AutoStartAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Enable => "enable",
            Self::Disable => "disable",
        }
    }

    fn request_id(self) -> &'static str {
        match self {
            Self::Status => "desktop-auto-start-status",
            Self::Enable => "desktop-auto-start-enable",
            Self::Disable => "desktop-auto-start-disable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClientTokenCommand {
    List {
        protocol_id: String,
    },
    Create {
        protocol_id: String,
        scope: ClientTokenScopeWire,
        token: Option<String>,
    },
    Reveal {
        protocol_id: String,
        scope: Option<ClientTokenScopeWire>,
    },
    Rotate {
        protocol_id: String,
        expected_revision: u64,
        scope: Option<ClientTokenScopeWire>,
        token: Option<String>,
    },
    Remove {
        protocol_id: String,
        expected_revision: u64,
        scope: Option<ClientTokenScopeWire>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ClientTokenScopeWire {
    #[serde(rename = "type")]
    pub(crate) scope_type: String,
    #[serde(rename = "projectDir", skip_serializing_if = "Option::is_none")]
    pub(crate) project_dir: Option<String>,
}

fn scope_json(scope: &ClientTokenScopeWire) -> Value {
    let mut value = json!({ "type": scope.scope_type });
    if let Some(project_dir) = &scope.project_dir {
        value["projectDir"] = json!(project_dir);
    }
    value
}

impl ClientTokenCommand {
    fn request_id(&self) -> &'static str {
        match self {
            Self::List { .. } => "desktop-client-tokens-list",
            Self::Create { .. } => "desktop-client-tokens-create",
            Self::Reveal { .. } => "desktop-client-tokens-reveal",
            Self::Rotate { .. } => "desktop-client-tokens-rotate",
            Self::Remove { .. } => "desktop-client-tokens-remove",
        }
    }
}

pub(crate) enum ModelsCommand {
    Query,
    WriteRaw { revision: u64, content: String },
    WriteStructured { revision: u64, providers: Value },
}

impl ModelsCommand {
    fn request_id(&self) -> &'static str {
        match self {
            Self::Query => "desktop-models-query",
            Self::WriteRaw { .. } => "desktop-models-write-raw",
            Self::WriteStructured { .. } => "desktop-models-write-structured",
        }
    }

    fn wire(&self) -> Value {
        match self {
            Self::Query => json!({ "command": "query" }),
            Self::WriteRaw { revision, content } => json!({
                "command": "write_raw",
                "revision": revision,
                "content": content,
            }),
            Self::WriteStructured {
                revision,
                providers,
            } => json!({
                "command": "write_structured",
                "revision": revision,
                "providers": providers,
            }),
        }
    }
}

/// Ticket 14: versioned alias registry commands — query the authoritative
/// model-aliases.json state or replace the user mapping record with a
/// compare-and-swap on the revision the client was served. Thin
/// allowlisted transport only; all domain/persistence/snapshot logic lives
/// in TypeScript.
pub(crate) enum AliasCommand {
    Query,
    Write { revision: u64, aliases: Value },
}

impl AliasCommand {
    fn request_id(&self) -> &'static str {
        match self {
            Self::Query => "desktop-aliases-query",
            Self::Write { .. } => "desktop-aliases-write",
        }
    }

    fn wire(&self) -> Value {
        match self {
            Self::Query => json!({ "command": "query" }),
            Self::Write { revision, aliases } => json!({
                "command": "write",
                "revision": revision,
                "aliases": aliases,
            }),
        }
    }
}

impl RuntimeCommand {
    fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }

    fn request_id(self) -> &'static str {
        match self {
            Self::Start => "desktop-start",
            Self::Stop => "desktop-stop",
            Self::Restart => "desktop-restart",
        }
    }
}

/// Versioned Credential commands (Ticket 12): the renderer manages the one
/// Pi-compatible auth.json through the single Credential Authority.
/// Mutations carry the expected revision from a prior query so a stale UI
/// can never overwrite a newer credential; import is confirmed Provider by
/// Provider against the preview plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CredentialCommand {
    Query,
    Login {
        provider_id: String,
        expected_revision: u64,
        value: String,
        overwrite: bool,
    },
    Logout {
        provider_id: String,
        expected_revision: u64,
    },
    ImportPreview {
        expected_revision: u64,
        content: String,
    },
    ImportApply {
        expected_revision: u64,
        import_id: String,
        selections: Vec<CredentialImportSelectionWire>,
    },
}

impl CredentialCommand {
    fn request_id(&self) -> &'static str {
        match self {
            Self::Query => "desktop-credentials-query",
            Self::Login { .. } => "desktop-credentials-login",
            Self::Logout { .. } => "desktop-credentials-logout",
            Self::ImportPreview { .. } => "desktop-credentials-import-preview",
            Self::ImportApply { .. } => "desktop-credentials-import-apply",
        }
    }

    fn wire(&self) -> Value {
        match self {
            Self::Query => json!({ "command": "query" }),
            Self::Login {
                provider_id,
                expected_revision,
                value,
                overwrite,
            } => json!({
                "command": "login",
                "providerId": provider_id,
                "expectedRevision": expected_revision,
                "value": value,
                "overwrite": overwrite,
            }),
            Self::Logout {
                provider_id,
                expected_revision,
            } => json!({
                "command": "logout",
                "providerId": provider_id,
                "expectedRevision": expected_revision,
            }),
            Self::ImportPreview {
                expected_revision,
                content,
            } => json!({
                "command": "import_preview",
                "expectedRevision": expected_revision,
                "content": content,
            }),
            Self::ImportApply {
                expected_revision,
                import_id,
                selections,
            } => json!({
                "command": "import_apply",
                "expectedRevision": expected_revision,
                "importId": import_id,
                "selections": selections,
            }),
        }
    }
}

/// Versioned Provider-auth commands (Ticket 13): `query` returns the
/// per-Provider login options plus the refreshed effective authentication
/// status; `login` runs a Provider-owned interactive flow through the
/// typed interaction channel. Rust stays a thin allowlisted transport: no
/// Provider branches or auth state machine ever live here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AuthCommand {
    Query,
    Login {
        provider_id: String,
        auth_type: String,
        /// Per-flow correlation id stamped on the command frame, the
        /// interaction events and the interaction responses.
        request_id: String,
    },
}

impl AuthCommand {
    fn request_id(&self) -> &str {
        match self {
            Self::Query => "desktop-auth-query",
            Self::Login { request_id, .. } => request_id,
        }
    }

    fn wire(&self) -> Value {
        match self {
            Self::Query => json!({ "command": "query" }),
            Self::Login {
                provider_id,
                auth_type,
                ..
            } => json!({
                "command": "login",
                "providerId": provider_id,
                "authType": auth_type,
            }),
        }
    }
}

pub(crate) enum ConnectResult {
    Connected(Box<dyn ControlPlaneSession>),
    VersionMismatch {
        requested_version: u64,
        supported_versions: Vec<u64>,
    },
}

pub(crate) trait ControlPlaneSession: Send {
    fn application_version(&self) -> &str;
    fn snapshot(&self) -> &StatusSnapshot;
    fn next_status(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<StatusSnapshot, SessionFailure>> + Send + '_>>;
}

pub(crate) struct ConnectedSession {
    pipe: NamedPipeClient,
    application_version: String,
    snapshot: StatusSnapshot,
}

impl ConnectedSession {
    fn new(pipe: NamedPipeClient, application_version: String, snapshot: StatusSnapshot) -> Self {
        Self {
            pipe,
            application_version,
            snapshot,
        }
    }
}

impl ControlPlaneSession for ConnectedSession {
    fn application_version(&self) -> &str {
        &self.application_version
    }

    fn snapshot(&self) -> &StatusSnapshot {
        &self.snapshot
    }

    fn next_status(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<StatusSnapshot, SessionFailure>> + Send + '_>> {
        Box::pin(async move {
            // The status-only subscription skips typed non-status events
            // (e.g. Ticket 07 diagnostics events) instead of treating them
            // as protocol errors: they belong to other subscribers and must
            // never tear down the status stream.
            loop {
                let value =
                    read_json_frame(&mut self.pipe)
                        .await
                        .map_err(|failure| match failure {
                            FrameFailure::Io => SessionFailure::TransportLost,
                            FrameFailure::Protocol => SessionFailure::ProtocolError,
                        })?;
                match decode_status_event(&value) {
                    Some(snapshot) => return Ok(snapshot),
                    None => match decode_foreign_event(&value) {
                        // A well-formed but non-status typed event: skip it.
                        Some(()) => continue,
                        // Malformed or unreadable status frames stay fatal.
                        None => return Err(SessionFailure::ProtocolError),
                    },
                }
            }
        })
    }
}

/** Versioned catalog commands (Ticket 11): query the one authoritative
 * active catalog snapshot or trigger a refresh (non-blocking background for
 * page-open, forced manual with bounded per-Provider results). The wire
 * shape mirrors the Control Plane contract exactly. */
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CatalogCommand {
    Query,
    RefreshBackground,
    RefreshManual,
}

impl CatalogCommand {
    fn request_id(&self) -> &'static str {
        match self {
            Self::Query => "desktop-catalog-query",
            Self::RefreshBackground => "desktop-catalog-refresh-background",
            Self::RefreshManual => "desktop-catalog-refresh-manual",
        }
    }

    fn wire(&self) -> Value {
        match self {
            Self::Query => json!({ "command": "query" }),
            Self::RefreshBackground => json!({ "command": "refresh", "mode": "background" }),
            Self::RefreshManual => json!({ "command": "refresh", "mode": "manual" }),
        }
    }
}

/// Sanitized catalog snapshot top-level projection (Ticket 11): the version
/// identity and the provider/error arrays pass through as opaque JSON — the
/// Control Plane already validated the value-safe facts, and the renderer
/// strictly re-decodes them. Rust stays a thin allowlisted transport.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub(crate) struct CatalogSnapshotWire {
    pub(crate) version: u64,
    #[serde(rename = "modelsJsonValid")]
    pub(crate) models_json_valid: bool,
    #[serde(rename = "refreshedAt", skip_serializing_if = "Option::is_none")]
    pub(crate) refreshed_at: Option<u64>,
    pub(crate) providers: Vec<Value>,
    #[serde(rename = "refreshErrors")]
    pub(crate) refresh_errors: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub(crate) struct CatalogCommandResultWire {
    pub(crate) outcome: String,
    pub(crate) snapshot: CatalogSnapshotWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) refresh: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryRangeBoundsWire {
    #[serde(rename = "fromMs", skip_serializing_if = "Option::is_none")]
    pub(crate) from_ms: Option<u64>,
    #[serde(rename = "toMs", skip_serializing_if = "Option::is_none")]
    pub(crate) to_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum HistoryRangeWire {
    All(String),
    Bounds(HistoryRangeBoundsWire),
}

impl HistoryRangeWire {
    fn is_valid(&self) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        match self {
            Self::All(value) => value == "all",
            Self::Bounds(bounds) => {
                (bounds.from_ms.is_some() || bounds.to_ms.is_some())
                    && bounds.from_ms.is_none_or(|value| value <= MAX_SAFE_INTEGER)
                    && bounds.to_ms.is_none_or(|value| value <= MAX_SAFE_INTEGER)
                    && match (bounds.from_ms, bounds.to_ms) {
                        (Some(from), Some(to)) => from <= to,
                        _ => true,
                    }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryExportCommandWire {
    pub(crate) range: HistoryRangeWire,
    pub(crate) capture: String,
    #[serde(rename = "destinationPath")]
    pub(crate) destination_path: String,
    pub(crate) overwrite: bool,
}

impl HistoryExportCommandWire {
    fn is_valid(&self) -> bool {
        self.range.is_valid()
            && matches!(self.capture.as_str(), "excluded" | "included")
            && !self.destination_path.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryDeleteCommandWire {
    pub(crate) range: HistoryRangeWire,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryCountsWire {
    #[serde(rename = "requestLedger")]
    pub(crate) request_ledger: u64,
    pub(crate) diagnostics: u64,
    pub(crate) capture: u64,
}

impl HistoryCountsWire {
    fn is_valid(&self) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        self.request_ledger <= MAX_SAFE_INTEGER
            && self.diagnostics <= MAX_SAFE_INTEGER
            && self.capture <= MAX_SAFE_INTEGER
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryQueryResultWire {
    pub(crate) range: HistoryRangeWire,
    pub(crate) counts: HistoryCountsWire,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistorySourceSummaryWire {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u64,
    pub(crate) count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryCaptureSummaryWire {
    pub(crate) included: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(rename = "schemaVersion", skip_serializing_if = "Option::is_none")]
    pub(crate) schema_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) count: Option<u64>,
}

impl HistoryCaptureSummaryWire {
    fn is_valid(&self) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        if self.included {
            self.reason.is_none()
                && self.schema_version.is_some()
                && self.count.is_some_and(|count| count <= MAX_SAFE_INTEGER)
        } else {
            self.reason.as_deref() == Some("excluded-by-default")
                && self.schema_version.is_none()
                && self.count.is_none()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryManifestSourcesWire {
    #[serde(rename = "requestLedger")]
    pub(crate) request_ledger: HistorySourceSummaryWire,
    pub(crate) diagnostics: HistorySourceSummaryWire,
    pub(crate) capture: HistoryCaptureSummaryWire,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryExportManifestWire {
    #[serde(rename = "manifestVersion")]
    pub(crate) manifest_version: u64,
    #[serde(rename = "exportedAt")]
    pub(crate) exported_at: u64,
    pub(crate) sensitive: bool,
    #[serde(rename = "auditUnavailable")]
    pub(crate) audit_unavailable: bool,
    pub(crate) sources: HistoryManifestSourcesWire,
}

impl HistoryExportManifestWire {
    fn is_valid(&self) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        self.manifest_version == 1
            && self.exported_at <= MAX_SAFE_INTEGER
            && self.sources.request_ledger.schema_version <= MAX_SAFE_INTEGER
            && self.sources.request_ledger.count <= MAX_SAFE_INTEGER
            && self.sources.diagnostics.schema_version <= MAX_SAFE_INTEGER
            && self.sources.diagnostics.count <= MAX_SAFE_INTEGER
            && self.sources.capture.is_valid()
            && self.sensitive == self.sources.capture.included
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryExportFailureWire {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryExportResultWire {
    pub(crate) outcome: String,
    #[serde(rename = "actionId", skip_serializing_if = "Option::is_none")]
    pub(crate) action_id: Option<String>,
    #[serde(
        rename = "confirmationMessage",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) confirmation_message: Option<String>,
    #[serde(rename = "exportId", skip_serializing_if = "Option::is_none")]
    pub(crate) export_id: Option<String>,
    #[serde(rename = "destinationPath", skip_serializing_if = "Option::is_none")]
    pub(crate) destination_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) manifest: Option<HistoryExportManifestWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) failure: Option<HistoryExportFailureWire>,
}

impl HistoryExportResultWire {
    fn is_valid(&self) -> bool {
        let nonempty =
            |value: &Option<String>| value.as_ref().is_some_and(|value| !value.is_empty());
        match self.outcome.as_str() {
            "ok" => {
                nonempty(&self.export_id)
                    && nonempty(&self.destination_path)
                    && self
                        .manifest
                        .as_ref()
                        .is_some_and(HistoryExportManifestWire::is_valid)
                    && self.action_id.is_none()
                    && self.confirmation_message.is_none()
                    && self.failure.is_none()
            }
            "confirmation_required" => {
                nonempty(&self.action_id)
                    && nonempty(&self.confirmation_message)
                    && self.export_id.is_none()
                    && self.destination_path.is_none()
                    && self.manifest.is_none()
                    && self.failure.is_none()
            }
            "failed" => {
                self.failure.as_ref().is_some_and(|failure| {
                    matches!(
                        failure.code.as_str(),
                        "invalid_destination"
                            | "destination_exists"
                            | "destination_locked"
                            | "export_too_large"
                            | "source_unavailable"
                            | "cancelled"
                            | "internal"
                    ) && !failure.message.is_empty()
                }) && self.action_id.is_none()
                    && self.confirmation_message.is_none()
                    && self.export_id.is_none()
                    && self.destination_path.is_none()
                    && self.manifest.is_none()
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryDeletePreviewWire {
    pub(crate) range: HistoryRangeWire,
    pub(crate) counts: HistoryCountsWire,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryDeleteFailureWire {
    pub(crate) authority: String,
    pub(crate) code: String,
    pub(crate) deleted: u64,
}

impl HistoryDeleteFailureWire {
    fn is_valid(&self) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        matches!(
            self.authority.as_str(),
            "requestLedger" | "diagnostics" | "capture"
        ) && matches!(self.code.as_str(), "storage_failure" | "internal")
            && self.deleted <= MAX_SAFE_INTEGER
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct HistoryDeleteResultWire {
    pub(crate) outcome: String,
    #[serde(rename = "actionId", skip_serializing_if = "Option::is_none")]
    pub(crate) action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) preview: Option<HistoryDeletePreviewWire>,
    #[serde(
        rename = "confirmationMessage",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) confirmation_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) deleted: Option<HistoryCountsWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) failures: Option<Vec<HistoryDeleteFailureWire>>,
}

impl HistoryDeleteResultWire {
    fn is_valid(&self) -> bool {
        let confirmation_is_valid = self
            .confirmation_message
            .as_ref()
            .is_some_and(|message| !message.is_empty());
        match self.outcome.as_str() {
            "confirmation_required" => {
                self.action_id.as_ref().is_some_and(|id| !id.is_empty())
                    && confirmation_is_valid
                    && self.preview.as_ref().is_some_and(|preview| {
                        preview.range.is_valid() && preview.counts.is_valid()
                    })
                    && self.deleted.is_none()
                    && self.failures.is_none()
            }
            "completed" => {
                self.action_id.is_none()
                    && self.preview.is_none()
                    && self.confirmation_message.is_none()
                    && self
                        .deleted
                        .as_ref()
                        .is_some_and(HistoryCountsWire::is_valid)
                    && self.failures.is_none()
            }
            "partial_failure" | "failed" => {
                self.action_id.is_none()
                    && self.preview.is_none()
                    && self.confirmation_message.is_none()
                    && self
                        .deleted
                        .as_ref()
                        .is_some_and(HistoryCountsWire::is_valid)
                    && self.failures.as_ref().is_some_and(|failures| {
                        !failures.is_empty()
                            && failures.iter().all(HistoryDeleteFailureWire::is_valid)
                    })
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HistoryCommandResultWire {
    Query(HistoryQueryResultWire),
    Export(HistoryExportResultWire),
    Delete(HistoryDeleteResultWire),
}

pub(crate) type ConnectFuture =
    Pin<Box<dyn Future<Output = Result<ConnectResult, ConnectionFailure>> + Send + 'static>>;
pub(crate) type CommandFuture =
    Pin<Box<dyn Future<Output = Result<StatusSnapshot, ConnectionFailure>> + Send + 'static>>;
pub(crate) type SettingsCommandFuture = Pin<
    Box<dyn Future<Output = Result<SettingsCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;
pub(crate) type HistoryAcknowledgeFuture =
    Pin<Box<dyn Future<Output = Result<StatusSnapshot, ConnectionFailure>> + Send + 'static>>;
pub(crate) type HistoryCommandFuture = Pin<
    Box<dyn Future<Output = Result<HistoryCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;
pub(crate) type AutoStartFuture =
    Pin<Box<dyn Future<Output = Result<AutoStartResultWire, ConnectionFailure>> + Send + 'static>>;

pub(crate) type ClientTokenCommandFuture = Pin<
    Box<
        dyn Future<Output = Result<ClientTokenCommandResultWire, ConnectionFailure>>
            + Send
            + 'static,
    >,
>;
pub(crate) type DiagnosticsWarningsFuture = Pin<
    Box<
        dyn Future<Output = Result<Vec<DiagnosticsWarningWire>, ConnectionFailure>>
            + Send
            + 'static,
    >,
>;

pub(crate) type RequestIdentitiesFuture = Pin<
    Box<
        dyn Future<Output = Result<Vec<RequestIdentityRecordWire>, ConnectionFailure>>
            + Send
            + 'static,
    >,
>;

pub(crate) type RequestLedgerQueryFuture = Pin<
    Box<dyn Future<Output = Result<RequestLedgerResultWire, ConnectionFailure>> + Send + 'static>,
>;
pub(crate) type AnalyticsQueryFuture =
    Pin<Box<dyn Future<Output = Result<AnalyticsResultWire, ConnectionFailure>> + Send + 'static>>;
pub(crate) type RequestLedgerSubscribeFuture = Pin<
    Box<
        dyn Future<Output = Result<RequestLedgerSubscribeStart, ConnectionFailure>>
            + Send
            + 'static,
    >,
>;

pub(crate) type ModelsCommandFuture = Pin<
    Box<dyn Future<Output = Result<ModelsCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;

pub(crate) type CatalogCommandFuture = Pin<
    Box<dyn Future<Output = Result<CatalogCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;
pub(crate) type CredentialCommandFuture = Pin<
    Box<
        dyn Future<Output = Result<CredentialCommandResultWire, ConnectionFailure>>
            + Send
            + 'static,
    >,
>;
pub(crate) type AliasCommandFuture = Pin<
    Box<dyn Future<Output = Result<AliasCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;
pub(crate) type AuthQueryFuture = Pin<
    Box<dyn Future<Output = Result<AuthCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;
pub(crate) type AuthLoginFuture =
    Pin<Box<dyn Future<Output = Result<AuthLoginStart, ConnectionFailure>> + Send + 'static>>;

pub(crate) trait ControlPlaneConnector: Send + Sync {
    fn connect(&self) -> ConnectFuture;
    fn command(&self, _command: RuntimeCommand) -> CommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn settings_command(&self, _command: SettingsCommand) -> SettingsCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    /// Ticket 23: acknowledges the audit-unavailable state; returns the
    /// fresh status snapshot so the renderer's banner reflects the
    /// acknowledgment immediately. Acknowledgment never claims recovery.
    fn history_acknowledge(&self) -> HistoryAcknowledgeFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn history_command(&self, _command: HistoryCommand) -> HistoryCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn auto_start(&self, _action: AutoStartAction) -> AutoStartFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn client_token_command(&self, _command: ClientTokenCommand) -> ClientTokenCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn credential_command(&self, _command: CredentialCommand) -> CredentialCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn auth_query(&self) -> AuthQueryFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn auth_login(
        &self,
        _command: AuthCommand,
        _on_event: Box<dyn FnMut(Value) + Send + 'static>,
    ) -> AuthLoginFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn diagnostics_warnings(&self) -> DiagnosticsWarningsFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn request_identities(&self) -> RequestIdentitiesFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    /// One-shot bounded Request Ledger query (Ticket 19): the query object
    /// is forwarded verbatim; the native shell never interprets filters.
    fn request_ledger_query(&self, _query: Option<Value>) -> RequestLedgerQueryFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    /// One-shot versioned analytics query (Ticket 21): the query object is
    /// forwarded verbatim; the native shell never computes aggregates.
    fn analytics_query(&self, _query: Value) -> AnalyticsQueryFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    /// Long-lived Request Ledger subscription (Ticket 19): forwards
    /// allowlisted committed records to the emitter; dropping the returned
    /// session ends the subscription. The `request_id` is the session's
    /// correlation identity.
    fn request_ledger_subscribe(
        &self,
        _request_id: String,
        _on_ledger_event: Box<dyn FnMut(Value) + Send + 'static>,
    ) -> RequestLedgerSubscribeFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn models_command(&self, _command: ModelsCommand) -> ModelsCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn catalog_command(&self, _command: CatalogCommand) -> CatalogCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn alias_command(&self, _command: AliasCommand) -> AliasCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct MaskedClientTokenScopeWire {
    #[serde(rename = "type")]
    pub(crate) scope_type: String,
    #[serde(rename = "projectDir", skip_serializing_if = "Option::is_none")]
    pub(crate) project_dir: Option<String>,
    #[serde(rename = "maskedToken")]
    pub(crate) masked_token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct ClientTokenCommandResultWire {
    pub(crate) outcome: String,
    pub(crate) revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scopes: Option<Vec<MaskedClientTokenScopeWire>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CredentialImportSelectionWire {
    #[serde(rename = "providerId")]
    pub(crate) provider_id: String,
    pub(crate) overwrite: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CredentialImportEntryPreviewWire {
    #[serde(rename = "providerId")]
    pub(crate) provider_id: String,
    #[serde(rename = "type")]
    pub(crate) entry_type: String,
    #[serde(rename = "wouldOverwrite")]
    pub(crate) would_overwrite: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CredentialImportApplyEntryResultWire {
    #[serde(rename = "providerId")]
    pub(crate) provider_id: String,
    pub(crate) outcome: String,
}

/// Bounded per-Provider authentication facts (Ticket 12): credential
/// values, environment names, command text and headers never cross this
/// bridge.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct ProviderAuthStatusWire {
    #[serde(rename = "providerId")]
    pub(crate) provider_id: String,
    pub(crate) stored: bool,
    #[serde(rename = "storedType", skip_serializing_if = "Option::is_none")]
    pub(crate) stored_type: Option<String>,
    pub(crate) environment: bool,
    #[serde(rename = "modelsJson")]
    pub(crate) models_json: bool,
    #[serde(rename = "commandDerived")]
    pub(crate) command_derived: bool,
    pub(crate) expired: bool,
    pub(crate) unavailable: bool,
    #[serde(rename = "effectiveSource")]
    pub(crate) effective_source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CredentialFileErrorWire {
    pub(crate) kind: String,
    pub(crate) message: String,
}

/// Sanitized auth.json projection merged into status snapshots (Ticket 12).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CredentialProjectionWire {
    pub(crate) revision: u64,
    pub(crate) path: String,
    pub(crate) present: bool,
    pub(crate) valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<CredentialFileErrorWire>,
    pub(crate) providers: Vec<ProviderAuthStatusWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CredentialCommandResultWire {
    pub(crate) outcome: String,
    pub(crate) revision: u64,
    pub(crate) state: CredentialProjectionWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) changed: Option<bool>,
    #[serde(rename = "importId", skip_serializing_if = "Option::is_none")]
    pub(crate) import_id: Option<String>,
    #[serde(rename = "previewEntries", skip_serializing_if = "Option::is_none")]
    pub(crate) preview_entries: Option<Vec<CredentialImportEntryPreviewWire>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) entries: Option<Vec<CredentialImportApplyEntryResultWire>>,
}

/// Versioned Provider-auth result envelope (Ticket 13): the sanitized
/// auth.json projection (the same strict shape as the Ticket 12 credential
/// command — credential values can never pass), the Provider-declared
/// options as opaque JSON (the renderer re-decodes them strictly), and a
/// value-free error. Non-ok outcomes never carry options; a login result
/// never carries options.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AuthCommandResultWire {
    pub(crate) outcome: String,
    pub(crate) state: CredentialProjectionWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

/// A typed client response routed into one in-flight Provider-owned login
/// flow (Ticket 13). Only the two allowlisted shapes exist; the response
/// carries a prompt correlation id so answers never cross flows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AuthInteractionResponse {
    PromptResponse { prompt_id: String, value: String },
    Cancel,
}

impl AuthInteractionResponse {
    fn wire(&self) -> Value {
        match self {
            Self::PromptResponse { prompt_id, value } => json!({
                "type": "prompt_response",
                "promptId": prompt_id,
                "value": value,
            }),
            Self::Cancel => json!({ "type": "cancel" }),
        }
    }
}

/// Strict response decode at the native bridge: only the two allowlisted
/// shapes pass; anything else is rejected before it reaches the pipe.
pub(crate) fn decode_auth_interaction_response(value: &Value) -> Option<AuthInteractionResponse> {
    let object = value.as_object()?;
    match object.get("type").and_then(Value::as_str) {
        Some("cancel") => Some(AuthInteractionResponse::Cancel),
        Some("prompt_response") => {
            let prompt_id = object.get("promptId").and_then(Value::as_str)?;
            let value = object.get("value").and_then(Value::as_str)?;
            if prompt_id.is_empty() {
                return None;
            }
            Some(AuthInteractionResponse::PromptResponse {
                prompt_id: prompt_id.to_owned(),
                value: value.to_owned(),
            })
        }
        _ => None,
    }
}

/// The long-lived login session handle: the write half stays in the shell
/// bridge so typed responses can be routed into the flow. Dropping the
/// session aborts the reader loop and closes the pipe, so a replaced or
/// shut-down login can never keep forwarding events and the Control Plane
/// host sees the connection loss and aborts the Provider-owned flow.
///
/// The session also owns the flow's correlation id (stamped on every
/// response frame) and the current pending prompt id: a `prompt_response`
/// whose prompt id does not match the flow's outstanding prompt is
/// rejected locally and never written to the pipe, so a stale response
/// from an earlier completed/cancelled flow can never reach — or tear
/// down — the active flow.
pub(crate) struct AuthLoginSession {
    pub(crate) write: tokio::io::WriteHalf<NamedPipeClient>,
    request_id: String,
    current_prompt: Arc<tokio::sync::Mutex<Option<String>>>,
    pub(crate) cancel: Arc<Notify>,
}

impl Drop for AuthLoginSession {
    fn drop(&mut self) {
        self.cancel.notify_one();
    }
}

impl AuthLoginSession {
    /// The per-flow correlation id stamped on the command/event/response
    /// frames of this login.
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Routes one typed response into the active login flow. A
    /// `prompt_response` must match the flow's current pending prompt id
    /// (the prompt the reader loop last forwarded); a mismatch — a stale
    /// response from an earlier flow, or a duplicate of an already
    /// answered prompt — is rejected before anything is written. `cancel`
    /// is always valid. After a successful write the pending slot is
    /// cleared until the next prompt event arrives.
    pub(crate) async fn respond(
        &mut self,
        response: &AuthInteractionResponse,
    ) -> Result<(), ConnectionFailure> {
        if let AuthInteractionResponse::PromptResponse { prompt_id, .. } = response {
            let mut pending = self.current_prompt.lock().await;
            if pending.as_deref() != Some(prompt_id.as_str()) {
                return Err(ConnectionFailure::ProtocolError);
            }
            write_json_frame(
                &mut self.write,
                &json!({
                    "type": "auth_interaction_response",
                    "requestId": self.request_id,
                    "response": response.wire(),
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            *pending = None;
            return Ok(());
        }
        write_json_frame(
            &mut self.write,
            &json!({
                "type": "auth_interaction_response",
                "requestId": self.request_id,
                "response": response.wire(),
            }),
        )
        .await
        .map_err(FrameFailure::connection_failure)
    }
}

/// The start of one login flow: the shared session handle plus the
/// terminal result, resolved by the reader loop once the Control Plane
/// answers the login command.
pub(crate) struct AuthLoginStart {
    pub(crate) session: AuthLoginSession,
    pub(crate) result: oneshot::Receiver<Result<AuthCommandResultWire, ConnectionFailure>>,
}

/// Sanitized Dashboard warning projection: only the safe fields of a
/// diagnostics record are forwarded to the renderer; details/errors are
/// deliberately never forwarded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct DiagnosticsWarningWire {
    pub(crate) id: u64,
    pub(crate) level: String,
    pub(crate) time: u64,
    pub(crate) text: String,
}

/// Request identity ledger record (Ticket 17 identity seam; Ticket 18
/// handoff): only the optional client-provided session id and the canonical
/// project context ride the wire. The internal effective session identity
/// is not a field of this contract, so the renderer can never show it as
/// the client's id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RequestIdentityRecordWire {
    pub(crate) id: u64,
    pub(crate) time: u64,
    #[serde(rename = "protocolId")]
    pub(crate) protocol_id: String,
    #[serde(rename = "clientSessionId", skip_serializing_if = "Option::is_none")]
    pub(crate) client_session_id: Option<String>,
    #[serde(rename = "projectDir", skip_serializing_if = "Option::is_none")]
    pub(crate) project_dir: Option<String>,
}

/// Request Lifecycle Ledger record (Ticket 18 surface, Ticket 19 relay):
/// the thin native shell validates every record strictly at this boundary
/// (allowlisted keys, UUID grammar per identity field, bounded strings,
/// HTTP status range) and forwards the validated projection. The `facts`
/// object is opaque here — the renderer strict-decodes its allowlisted
/// sub-keys — so the Rust side never interprets, derives, or re-shapes any
/// ledger state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RequestLedgerRecordWire {
    pub(crate) id: u64,
    #[serde(rename = "requestId")]
    pub(crate) request_id: String,
    #[serde(rename = "protocolId")]
    pub(crate) protocol_id: String,
    pub(crate) phase: String,
    pub(crate) outcome: String,
    #[serde(rename = "acceptedAt")]
    pub(crate) accepted_at: u64,
    #[serde(rename = "executionStartedAt", skip_serializing_if = "Option::is_none")]
    pub(crate) execution_started_at: Option<u64>,
    #[serde(rename = "terminalAt", skip_serializing_if = "Option::is_none")]
    pub(crate) terminal_at: Option<u64>,
    #[serde(rename = "completedAt", skip_serializing_if = "Option::is_none")]
    pub(crate) completed_at: Option<u64>,
    #[serde(rename = "clientHttpStatus", skip_serializing_if = "Option::is_none")]
    pub(crate) client_http_status: Option<u64>,
    #[serde(rename = "externalAlias", skip_serializing_if = "Option::is_none")]
    pub(crate) external_alias: Option<String>,
    #[serde(rename = "providerId", skip_serializing_if = "Option::is_none")]
    pub(crate) provider_id: Option<String>,
    #[serde(rename = "realModelId", skip_serializing_if = "Option::is_none")]
    pub(crate) real_model_id: Option<String>,
    #[serde(rename = "clientSessionId", skip_serializing_if = "Option::is_none")]
    pub(crate) client_session_id: Option<String>,
    #[serde(rename = "effectiveSessionId", skip_serializing_if = "Option::is_none")]
    pub(crate) effective_session_id: Option<String>,
    #[serde(rename = "projectDir", skip_serializing_if = "Option::is_none")]
    pub(crate) project_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) facts: Option<serde_json::Value>,
    #[serde(rename = "terminalUsage", skip_serializing_if = "Option::is_none")]
    pub(crate) terminal_usage: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RequestLedgerResultWire {
    pub(crate) records: Vec<RequestLedgerRecordWire>,
    #[serde(rename = "hasMore")]
    pub(crate) has_more: bool,
}

/// Ticket 21 analytics result relay: the thin native shell validates the
/// bounded versioned envelope (fixed version, exact command, summary and
/// options sub-shapes, no unknown/foreign key) and forwards it to the
/// renderer. Nested aggregate objects ride opaque here — the renderer
/// strict-decodes their allowlisted keys, so Rust never interprets,
/// derives, or re-shapes any analytics state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct AnalyticsResultWire {
    pub(crate) version: u64,
    pub(crate) command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) totals: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rows: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) truncated: Option<bool>,
    #[serde(rename = "omittedGroupCount", skip_serializing_if = "Option::is_none")]
    pub(crate) omitted_group_count: Option<u64>,
    #[serde(
        rename = "omittedGroupRequests",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) omitted_group_requests: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) buckets: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) providers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) protocols: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) projects: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) outcomes: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]

pub(crate) struct AutoStartResultWire {
    pub(crate) outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct SettingsCommandResultWire {
    pub(crate) outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) confirmation: Option<LanConfirmationWire>,
    #[serde(rename = "settings")]
    pub(crate) settings: BTreeMap<String, RegisteredSettingWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct ModelsFileErrorLocationWire {
    pub(crate) line: u64,
    pub(crate) column: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) position: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct ModelsFileErrorWire {
    pub(crate) kind: String,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) location: Option<ModelsFileErrorLocationWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct ModelsFileStateWire {
    pub(crate) revision: u64,
    pub(crate) path: String,
    pub(crate) present: bool,
    pub(crate) valid: bool,
    pub(crate) raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) providers: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ModelsFileErrorWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct ModelsCommandResultWire {
    pub(crate) outcome: String,
    pub(crate) state: ModelsFileStateWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ModelsFileErrorWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct ModelsProjectionWire {
    pub(crate) revision: u64,
    pub(crate) path: String,
    pub(crate) present: bool,
    pub(crate) valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ModelsFileErrorWire>,
}

/// Ticket 14 thin wire shapes: the sanitized model-aliases.json projection
/// (status snapshots), the value-free file error, the one effective alias
/// entry, the rejected entry, and the full authoritative state + command
/// result. The renderer re-validates every payload strictly.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasFileErrorWire {
    pub(crate) kind: String,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) entries: Option<Vec<AliasValidationErrorWire>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasValidationErrorWire {
    pub(crate) alias: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasCanonicalTargetWire {
    pub(crate) provider: String,
    pub(crate) model: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasEffectiveAliasWire {
    pub(crate) alias: String,
    pub(crate) target: AliasCanonicalTargetWire,
    pub(crate) layer: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasEffectiveRegistryWire {
    #[serde(rename = "defaultsVersion")]
    pub(crate) defaults_version: u64,
    pub(crate) aliases: Vec<AliasEffectiveAliasWire>,
    pub(crate) errors: Vec<AliasValidationErrorWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasFileStateWire {
    pub(crate) revision: u64,
    pub(crate) path: String,
    pub(crate) present: bool,
    pub(crate) valid: bool,
    pub(crate) raw: String,
    #[serde(rename = "defaultsVersion")]
    pub(crate) defaults_version: u64,
    #[serde(rename = "catalogVersion")]
    pub(crate) catalog_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) aliases: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) effective: Option<AliasEffectiveRegistryWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<AliasFileErrorWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasCommandResultWire {
    pub(crate) outcome: String,
    pub(crate) state: AliasFileStateWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<AliasFileErrorWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AliasesProjectionWire {
    pub(crate) revision: u64,
    pub(crate) path: String,
    pub(crate) present: bool,
    pub(crate) valid: bool,
    #[serde(rename = "defaultsVersion")]
    pub(crate) defaults_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<AliasFileErrorWire>,
}

pub(crate) struct NativeControlPlaneConnector {
    discovery: NativeControlPlaneDiscovery,
    auto_start_consumed: Arc<AtomicBool>,
}

impl NativeControlPlaneConnector {
    pub(crate) fn new(discovery: NativeControlPlaneDiscovery) -> Self {
        Self {
            discovery,
            auto_start_consumed: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl ControlPlaneConnector for NativeControlPlaneConnector {
    fn connect(&self) -> ConnectFuture {
        let discovery = self.discovery.clone();
        let auto_start_consumed = self.auto_start_consumed.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            // The automatic Start is a one-shot native lifecycle gate: the
            // first successful connection sends it exactly once. A failed or
            // version-mismatched handshake does not consume the gate, and a
            // connect aborted before completion keeps it armed, so the next
            // successful connection still auto-starts.
            let auto_start = !auto_start_consumed.load(Ordering::SeqCst);
            let result = connect_session(&pipe_name, capability, auto_start).await;
            if auto_start && matches!(result, Ok(ConnectResult::Connected(_))) {
                auto_start_consumed.store(true, Ordering::SeqCst);
            }
            result
        })
    }

    fn command(&self, command: RuntimeCommand) -> CommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_command_session(&pipe_name, capability, command).await
        })
    }

    fn settings_command(&self, command: SettingsCommand) -> SettingsCommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_settings_command_session(&pipe_name, capability, command).await
        })
    }

    fn history_acknowledge(&self) -> HistoryAcknowledgeFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_history_acknowledge_session(&pipe_name, capability).await
        })
    }

    fn history_command(&self, command: HistoryCommand) -> HistoryCommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_history_command_session(&pipe_name, capability, command).await
        })
    }

    fn auto_start(&self, action: AutoStartAction) -> AutoStartFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_auto_start_session(&pipe_name, capability, action).await
        })
    }

    fn client_token_command(&self, command: ClientTokenCommand) -> ClientTokenCommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_client_token_command_session(&pipe_name, capability, command).await
        })
    }

    fn credential_command(&self, command: CredentialCommand) -> CredentialCommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_credential_command_session(&pipe_name, capability, command).await
        })
    }

    fn auth_query(&self) -> AuthQueryFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_auth_query_session(&pipe_name, capability).await
        })
    }

    fn auth_login(
        &self,
        command: AuthCommand,
        on_event: Box<dyn FnMut(Value) + Send + 'static>,
    ) -> AuthLoginFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_auth_login_session(&pipe_name, capability, command, on_event).await
        })
    }

    fn diagnostics_warnings(&self) -> DiagnosticsWarningsFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_diagnostics_warnings_session(&pipe_name, capability).await
        })
    }

    fn request_identities(&self) -> RequestIdentitiesFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_request_identities_session(&pipe_name, capability).await
        })
    }

    fn request_ledger_query(&self, query: Option<Value>) -> RequestLedgerQueryFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_request_ledger_query_session(&pipe_name, capability, query).await
        })
    }

    fn analytics_query(&self, query: Value) -> AnalyticsQueryFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_analytics_query_session(&pipe_name, capability, query).await
        })
    }

    fn request_ledger_subscribe(
        &self,
        request_id: String,
        on_ledger_event: Box<dyn FnMut(Value) + Send + 'static>,
    ) -> RequestLedgerSubscribeFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_request_ledger_subscribe_session(
                &pipe_name,
                capability,
                request_id,
                on_ledger_event,
            )
            .await
        })
    }

    fn models_command(&self, command: ModelsCommand) -> ModelsCommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_models_command_session(&pipe_name, capability, command).await
        })
    }
    fn catalog_command(&self, command: CatalogCommand) -> CatalogCommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_catalog_command_session(&pipe_name, capability, command).await
        })
    }
    fn alias_command(&self, command: AliasCommand) -> AliasCommandFuture {
        let discovery = self.discovery.clone();
        Box::pin(async move {
            let authority = discovery
                .discover()
                .await
                .map_err(|failure| match failure {
                    DiscoveryFailure::Missing => ConnectionFailure::DescriptorMissing,
                    DiscoveryFailure::Invalid => ConnectionFailure::DescriptorInvalid,
                })?;
            let (pipe_name, capability) = authority.into_parts();
            execute_alias_command_session(&pipe_name, capability, command).await
        })
    }
}

async fn connect_session(
    pipe_name: &str,
    capability: String,
    auto_start: bool,
) -> Result<ConnectResult, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;

    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Incompatible {
            requested_version,
            supported_versions,
        } => Ok(ConnectResult::VersionMismatch {
            requested_version,
            supported_versions,
        }),
        Hello::Compatible {
            application_version,
        } => {
            let snapshot = if auto_start {
                // The one-shot automatic Start belongs to the first successful
                // native connection.
                execute_runtime_command(&mut pipe, RuntimeCommand::Start).await?
            } else {
                // Renderer Retry reconnect: query status only, never send a
                // second automatic Start.
                write_json_frame(
                    &mut pipe,
                    &json!({"type": "get_status", "requestId": "desktop-status"}),
                )
                .await
                .map_err(FrameFailure::connection_failure)?;
                let status = read_json_frame(&mut pipe)
                    .await
                    .map_err(FrameFailure::connection_failure)?;
                if status.get("type").and_then(Value::as_str) != Some("status_result")
                    || status.get("requestId").and_then(Value::as_str) != Some("desktop-status")
                {
                    return Err(ConnectionFailure::ProtocolError);
                }
                status
                    .get("snapshot")
                    .and_then(decode_status_snapshot)
                    .ok_or(ConnectionFailure::ProtocolError)?
            };
            write_json_frame(
                &mut pipe,
                &json!({"type": "subscribe", "requestId": "desktop-subscribe"}),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let subscribed = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            if subscribed.get("type").and_then(Value::as_str) != Some("subscribed")
                || subscribed.get("requestId").and_then(Value::as_str) != Some("desktop-subscribe")
            {
                return Err(ConnectionFailure::ProtocolError);
            }
            Ok(ConnectResult::Connected(Box::new(ConnectedSession::new(
                pipe,
                application_version,
                snapshot,
            ))))
        }
    }
}

async fn execute_command_session(
    pipe_name: &str,
    capability: String,
    command: RuntimeCommand,
) -> Result<StatusSnapshot, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => execute_runtime_command(&mut pipe, command).await,
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

async fn execute_settings_command_session(
    pipe_name: &str,
    capability: String,
    command: SettingsCommand,
) -> Result<SettingsCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "settings_command",
                    "requestId": command.request_id(),
                    "command": {
                        "command": command.as_str(),
                    },
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_settings_command_result(&result, command)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// One-shot History command transport. It projects the backend response into
/// an allowlisted DTO before anything is returned to the renderer.
async fn execute_history_command_session(
    pipe_name: &str,
    capability: String,
    command: HistoryCommand,
) -> Result<HistoryCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(&mut pipe, &command.request())
                .await
                .map_err(FrameFailure::connection_failure)?;
            let response = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            if response.get("type").and_then(Value::as_str) != Some(command.response_type())
                || response.get("requestId").and_then(Value::as_str) != Some(command.request_id())
            {
                return Err(ConnectionFailure::ProtocolError);
            }
            let result = response
                .get("result")
                .cloned()
                .ok_or(ConnectionFailure::ProtocolError)?;
            match command {
                HistoryCommand::Query { .. } => {
                    let result: HistoryQueryResultWire = serde_json::from_value(result)
                        .map_err(|_| ConnectionFailure::ProtocolError)?;
                    if !result.range.is_valid() || !result.counts.is_valid() {
                        return Err(ConnectionFailure::ProtocolError);
                    }
                    Ok(HistoryCommandResultWire::Query(result))
                }
                HistoryCommand::Export { .. } | HistoryCommand::ExportConfirm { .. } => {
                    let result: HistoryExportResultWire = serde_json::from_value(result)
                        .map_err(|_| ConnectionFailure::ProtocolError)?;
                    if !result.is_valid() {
                        return Err(ConnectionFailure::ProtocolError);
                    }
                    Ok(HistoryCommandResultWire::Export(result))
                }
                HistoryCommand::Delete { .. } | HistoryCommand::DeleteConfirm { .. } => {
                    let result: HistoryDeleteResultWire = serde_json::from_value(result)
                        .map_err(|_| ConnectionFailure::ProtocolError)?;
                    if !result.is_valid() {
                        return Err(ConnectionFailure::ProtocolError);
                    }
                    Ok(HistoryCommandResultWire::Delete(result))
                }
            }
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// Ticket 23: one-shot audit-unavailable acknowledgment. The session sends
/// the `history_acknowledge` frame, validates the result (the native shell
/// never interprets business state), then fetches the fresh status snapshot
/// so the renderer's banner reflects the acknowledgment immediately. The
/// backend owns every acknowledgment/recovery semantic; Rust only forwards
/// frames and projects fixed labels.
async fn execute_history_acknowledge_session(
    pipe_name: &str,
    capability: String,
) -> Result<StatusSnapshot, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "history_acknowledge",
                    "requestId": "desktop-history-acknowledge",
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            if result.get("type").and_then(Value::as_str) != Some("history_acknowledge_result")
                || result.get("requestId").and_then(Value::as_str)
                    != Some("desktop-history-acknowledge")
            {
                return Err(ConnectionFailure::ProtocolError);
            }
            let outcome = result
                .get("result")
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("outcome"))
                .and_then(Value::as_str);
            if !matches!(outcome, Some("ok" | "unchanged")) {
                return Err(ConnectionFailure::ProtocolError);
            }
            // Fresh snapshot: the acknowledgment (or the recovery that made
            // it unchanged) must be reflected in what the renderer shows.
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "get_status",
                    "requestId": "desktop-history-status",
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let status = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            if status.get("type").and_then(Value::as_str) != Some("status_result")
                || status.get("requestId").and_then(Value::as_str) != Some("desktop-history-status")
            {
                return Err(ConnectionFailure::ProtocolError);
            }
            status
                .get("snapshot")
                .and_then(decode_status_snapshot)
                .ok_or(ConnectionFailure::ProtocolError)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_settings_command_result(
    value: &Value,
    command: SettingsCommand,
) -> Result<SettingsCommandResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("settings_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    if !matches!(
        result.get("outcome").and_then(Value::as_str),
        Some(
            "ok" | "applied"
                | "pending"
                | "confirmation_required"
                | "unknown_key"
                | "invalid_value"
        )
    ) {
        return Err(ConnectionFailure::ProtocolError);
    }
    serde_json::from_value::<SettingsCommandResultWire>(Value::Object(result.clone()))
        .map_err(|_| ConnectionFailure::ProtocolError)
}

async fn execute_auto_start_session(
    pipe_name: &str,
    capability: String,
    action: AutoStartAction,
) -> Result<AutoStartResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "application_command",
                    "requestId": action.request_id(),
                    "command": {
                        "command": "auto_start",
                        "action": action.as_str(),
                    },
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_auto_start_result(&result, action)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_auto_start_result(
    value: &Value,
    action: AutoStartAction,
) -> Result<AutoStartResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("application_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(action.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    let outcome = result.get("outcome").and_then(Value::as_str);
    if result.get("command").and_then(Value::as_str) != Some("auto_start")
        || !matches!(outcome, Some("ok" | "failed" | "unsupported"))
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let enabled = if outcome == Some("ok") {
        Some(
            result
                .get("autoStart")
                .and_then(|raw| raw.get("enabled"))
                .and_then(Value::as_bool)
                .ok_or(ConnectionFailure::ProtocolError)?,
        )
    } else {
        None
    };
    Ok(AutoStartResultWire {
        outcome: outcome.unwrap_or_default().to_owned(),
        enabled,
    })
}

async fn execute_client_token_command_session(
    pipe_name: &str,
    capability: String,
    command: ClientTokenCommand,
) -> Result<ClientTokenCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            let wire_command = match &command {
                ClientTokenCommand::List { protocol_id } => json!({
                    "command": "list",
                    "protocolId": protocol_id,
                }),
                ClientTokenCommand::Create {
                    protocol_id,
                    scope,
                    token,
                } => {
                    let mut value = json!({
                        "command": "create",
                        "protocolId": protocol_id,
                        "scope": scope_json(scope),
                    });
                    if let Some(token) = token {
                        value["token"] = json!(token);
                    }
                    value
                }
                ClientTokenCommand::Reveal { protocol_id, scope } => {
                    let mut value = json!({
                        "command": "reveal",
                        "protocolId": protocol_id,
                    });
                    if let Some(scope) = scope {
                        value["scope"] = scope_json(scope);
                    }
                    value
                }
                ClientTokenCommand::Rotate {
                    protocol_id,
                    expected_revision,
                    scope,
                    token,
                } => {
                    let mut value = json!({
                        "command": "rotate",
                        "protocolId": protocol_id,
                        "expectedRevision": expected_revision,
                    });
                    if let Some(scope) = scope {
                        value["scope"] = scope_json(scope);
                    }
                    if let Some(token) = token {
                        value["token"] = json!(token);
                    }
                    value
                }
                ClientTokenCommand::Remove {
                    protocol_id,
                    expected_revision,
                    scope,
                } => {
                    let mut value = json!({
                        "command": "remove",
                        "protocolId": protocol_id,
                        "expectedRevision": expected_revision,
                    });
                    if let Some(scope) = scope {
                        value["scope"] = scope_json(scope);
                    }
                    value
                }
            };
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "client_token_command",
                    "requestId": command.request_id(),
                    "command": wire_command,
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_client_token_command_result(&result, &command)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_client_token_command_result(
    value: &Value,
    command: &ClientTokenCommand,
) -> Result<ClientTokenCommandResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("client_token_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    let outcome = result.get("outcome").and_then(Value::as_str);
    if !matches!(
        outcome,
        Some(
            "ok" | "conflict"
                | "not_found"
                | "invalid_value"
                | "already_exists"
                | "invalid_directory"
                | "unknown_protocol"
                | "unavailable"
        )
    ) || result.get("revision").and_then(Value::as_u64).is_none()
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    // Value-free canonicalization rejection: only the reason taxonomy is
    // forwarded; the raw input path never reaches the renderer.
    let reason = result.get("reason").and_then(Value::as_str);
    if (outcome == Some("invalid_directory")
        && !matches!(
            reason,
            Some("not_found" | "not_a_directory" | "inaccessible" | "race" | "invalid")
        ))
        || (outcome != Some("invalid_directory") && result.get("reason").is_some())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    // Reveal is the only command that may carry the active secret; list and
    // mutation results expose masked scopes only. A result that violates the
    // command's shape (e.g. a raw token in a masked field) never decodes.
    match (command, outcome) {
        (ClientTokenCommand::Reveal { .. }, Some("ok")) => {
            if result.get("token").and_then(Value::as_str).is_none()
                || result.get("scopes").is_some()
            {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        (ClientTokenCommand::List { .. }, Some("ok"))
        | (ClientTokenCommand::Create { .. }, Some("ok"))
        | (ClientTokenCommand::Rotate { .. }, Some("ok"))
        | (ClientTokenCommand::Remove { .. }, Some("ok")) => {
            if result.get("token").is_some() || !valid_masked_scopes(result.get("scopes")) {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        (_, _) => {
            if result.get("error").and_then(Value::as_str).is_none()
                || result.get("token").is_some()
                || result.get("scopes").is_some()
            {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
    }
    serde_json::from_value::<ClientTokenCommandResultWire>(Value::Object(result.clone()))
        .map_err(|_| ConnectionFailure::ProtocolError)
}

async fn execute_credential_command_session(
    pipe_name: &str,
    capability: String,
    command: CredentialCommand,
) -> Result<CredentialCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "credential_command",
                    "requestId": command.request_id(),
                    "command": command.wire(),
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_credential_command_result(&result, &command)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_credential_command_result(
    value: &Value,
    command: &CredentialCommand,
) -> Result<CredentialCommandResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("credential_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    let outcome = result.get("outcome").and_then(Value::as_str);
    if !matches!(
        outcome,
        Some(
            "ok" | "conflict"
                | "invalid"
                | "unknown_provider"
                | "overwrite_required"
                | "storage_failure"
                | "unavailable"
        )
    ) || result.get("revision").and_then(Value::as_u64).is_none()
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    // The sanitized projection is mandatory; credential values or raw
    // credential shapes can never pass this boundary (the wire struct's
    // strict Deserialize enforces the exact projection shape).
    let wire = serde_json::from_value::<CredentialCommandResultWire>(Value::Object(result.clone()))
        .map_err(|_| ConnectionFailure::ProtocolError)?;
    // Per-command extras: only the confirmed command's extras may ride on
    // the result; a login/logout result can never carry import artifacts
    // and vice versa.
    match (command, outcome) {
        (CredentialCommand::Login { .. } | CredentialCommand::Logout { .. }, Some("ok")) => {
            if wire.import_id.is_some() || wire.preview_entries.is_some() || wire.entries.is_some()
            {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        (CredentialCommand::ImportPreview { .. }, Some("ok")) => {
            // An empty Pi-compatible auth.json is a valid import: the
            // preview may legitimately carry zero entries.
            if wire.import_id.as_deref().unwrap_or_default().is_empty()
                || wire.preview_entries.is_none()
                || wire.changed.is_some()
                || wire.entries.is_some()
            {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        (CredentialCommand::ImportApply { .. }, Some("ok")) => {
            // An apply with zero confirmed selections is a valid no-op.
            if wire.entries.is_none() || wire.changed.is_some() || wire.import_id.is_some() {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        (CredentialCommand::Query, Some("ok")) => {
            if wire.changed.is_some()
                || wire.import_id.is_some()
                || wire.preview_entries.is_some()
                || wire.entries.is_some()
            {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        (_, _) => {
            if wire.error.as_deref().unwrap_or_default().is_empty() {
                return Err(ConnectionFailure::ProtocolError);
            }
            if matches!(command, CredentialCommand::ImportApply { .. }) {
                if wire.entries.is_none() {
                    return Err(ConnectionFailure::ProtocolError);
                }
            } else if wire.entries.is_some() || wire.preview_entries.is_some() {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
    }
    Ok(wire)
}

/// One-shot auth query (Ticket 13): negotiate, send the query, and expect
/// exactly one result frame — the host never emits interaction events for
/// a query (it runs with a no-op channel), so any other frame is a
/// protocol error.
async fn execute_auth_query_session(
    pipe_name: &str,
    capability: String,
) -> Result<AuthCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "auth_command",
                    "requestId": AuthCommand::Query.request_id(),
                    "command": AuthCommand::Query.wire(),
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_auth_command_result(&result, &AuthCommand::Query)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// Long-lived login session (Ticket 13): negotiate, send the login
/// command, then hand the pipe to a reader loop that forwards allowlisted
/// typed interaction events to the renderer and resolves the flow with the
/// terminal result. The returned session keeps the write half so typed
/// responses can be routed into the flow; dropping it aborts the reader
/// (the Control Plane host then sees the connection loss and aborts the
/// Provider-owned flow).
pub(crate) async fn execute_auth_login_session(
    pipe_name: &str,
    capability: String,
    command: AuthCommand,
    on_event: impl FnMut(Value) + Send + 'static,
) -> Result<AuthLoginStart, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "auth_command",
                    "requestId": command.request_id(),
                    "command": command.wire(),
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let (read, write) = split(pipe);
            let (result_sender, result_receiver) = oneshot::channel();
            let request_id = command.request_id().to_owned();
            let cancel = Arc::new(Notify::new());
            let current_prompt = Arc::new(tokio::sync::Mutex::new(None));
            tokio::spawn(auth_login_reader(
                read,
                request_id.clone(),
                command,
                cancel.clone(),
                current_prompt.clone(),
                on_event,
                result_sender,
            ));
            Ok(AuthLoginStart {
                session: AuthLoginSession {
                    write,
                    request_id,
                    current_prompt,
                    cancel,
                },
                result: result_receiver,
            })
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// The login reader loop: forwards allowlisted typed interaction events to
/// the renderer and resolves the flow with the terminal result. Any other
/// frame — including a malformed or secret-bearing event extension — is a
/// protocol error; a closed pipe is a transport failure (the host aborts
/// the flow on connection loss). The cancellation notify aborts the loop
/// when the session is replaced or the shell shuts down, so a dead login
/// never keeps forwarding events. Each forwarded prompt records its id as
/// the flow's current pending prompt so `respond` can reject stale
/// responses locally.
async fn auth_login_reader<R>(
    mut read: R,
    request_id: String,
    command: AuthCommand,
    cancel: Arc<Notify>,
    current_prompt: Arc<tokio::sync::Mutex<Option<String>>>,
    mut on_event: impl FnMut(Value) + Send + 'static,
    result_sender: oneshot::Sender<Result<AuthCommandResultWire, ConnectionFailure>>,
) where
    R: AsyncRead + Unpin,
{
    loop {
        tokio::select! {
            _ = cancel.notified() => {
                let _ = result_sender.send(Err(ConnectionFailure::PipeUnavailable));
                return;
            }
            frame = read_json_frame(&mut read) => {
                match frame {
                    Err(FrameFailure::Io) => {
                        let _ = result_sender.send(Err(ConnectionFailure::PipeUnavailable));
                        return;
                    }
                    Err(FrameFailure::Protocol) => {
                        let _ = result_sender.send(Err(ConnectionFailure::ProtocolError));
                        return;
                    }
                    Ok(value) => {
                        if value.get("type").and_then(Value::as_str)
                            == Some("auth_interaction_event")
                            && value.get("requestId").and_then(Value::as_str)
                                == Some(request_id.as_str())
                        {
                            match decode_auth_interaction_event(&value) {
                                Some(event) => {
                                    if event.get("type").and_then(Value::as_str)
                                        == Some("prompt")
                                    {
                                        if let Some(prompt_id) =
                                            event.get("promptId").and_then(Value::as_str)
                                        {
                                            *current_prompt.lock().await =
                                                Some(prompt_id.to_owned());
                                        }
                                    }
                                    on_event(event);
                                    continue;
                                }
                                None => {
                                    let _ = result_sender.send(Err(ConnectionFailure::ProtocolError));
                                    return;
                                }
                            }
                        }
                        if value.get("type").and_then(Value::as_str)
                            == Some("auth_command_result")
                        {
                            let _ = result_sender.send(decode_auth_command_result(&value, &command));
                            return;
                        }
                        let _ = result_sender.send(Err(ConnectionFailure::ProtocolError));
                        return;
                    }
                }
            }
        }
    }
}

/// Allowlisted typed interaction event: only the five event kinds pass the
/// native bridge; the payload rides as opaque JSON and the renderer
/// strictly re-decodes it (the bridge is a trust boundary).
fn decode_auth_interaction_event(value: &Value) -> Option<Value> {
    let event = value.get("event")?;
    let event_type = event.get("type").and_then(Value::as_str)?;
    matches!(
        event_type,
        "info" | "auth_url" | "device_code" | "progress" | "prompt"
    )
    .then(|| event.clone())
}

/// Strict auth result decode at the native bridge, validated against the
/// command that produced it: `query` may carry the options projection,
/// `login` never does; non-ok outcomes require a value-free error and
/// never carry options; only the unavailable DTO may carry an empty path.
fn decode_auth_command_result(
    value: &Value,
    command: &AuthCommand,
) -> Result<AuthCommandResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("auth_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    let outcome = result.get("outcome").and_then(Value::as_str);
    if !matches!(
        outcome,
        Some(
            "ok" | "cancelled"
                | "failed"
                | "conflict"
                | "unknown_provider"
                | "unsupported"
                | "storage_failure"
                | "unavailable"
        )
    ) {
        return Err(ConnectionFailure::ProtocolError);
    }
    let wire = serde_json::from_value::<AuthCommandResultWire>(Value::Object(result.clone()))
        .map_err(|_| ConnectionFailure::ProtocolError)?;
    // The unavailable DTO carries a minimal value-free state (no path);
    // every other outcome requires the normal non-empty projection.
    if wire.state.path.is_empty() && outcome != Some("unavailable") {
        return Err(ConnectionFailure::ProtocolError);
    }
    match outcome {
        Some("ok") => {
            // Value-free rule: an ok outcome never carries an error.
            if wire.error.is_some() {
                return Err(ConnectionFailure::ProtocolError);
            }
            match command {
                AuthCommand::Query => {
                    if wire.options.is_none() {
                        return Err(ConnectionFailure::ProtocolError);
                    }
                }
                AuthCommand::Login { .. } => {
                    if wire.options.is_some() {
                        return Err(ConnectionFailure::ProtocolError);
                    }
                }
            }
        }
        _ => {
            // Non-ok outcomes require a value-free error and never carry
            // the options projection.
            if wire.error.as_deref().is_none_or(str::is_empty) || wire.options.is_some() {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
    }
    Ok(wire)
}

async fn execute_models_command_session(
    pipe_name: &str,
    capability: String,
    command: ModelsCommand,
) -> Result<ModelsCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "models_command",
                    "requestId": command.request_id(),
                    "command": command.wire(),
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_models_command_result(&result, &command)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_models_command_result(
    value: &Value,
    command: &ModelsCommand,
) -> Result<ModelsCommandResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("models_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    if !matches!(
        result.get("outcome").and_then(Value::as_str),
        Some("ok" | "conflict" | "invalid" | "storage_failure")
    ) {
        return Err(ConnectionFailure::ProtocolError);
    }
    serde_json::from_value::<ModelsCommandResultWire>(Value::Object(result.clone()))
        .map_err(|_| ConnectionFailure::ProtocolError)
}

async fn execute_catalog_command_session(
    pipe_name: &str,
    capability: String,
    command: CatalogCommand,
) -> Result<CatalogCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "catalog_command",
                    "requestId": command.request_id(),
                    "command": command.wire(),
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_catalog_command_result(&result, &command)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_catalog_command_result(
    value: &Value,
    command: &CatalogCommand,
) -> Result<CatalogCommandResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("catalog_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    if !matches!(
        result.get("outcome").and_then(Value::as_str),
        Some("ok" | "scheduled" | "unavailable")
    ) {
        return Err(ConnectionFailure::ProtocolError);
    }
    let snapshot = result
        .get("snapshot")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    if snapshot.get("version").and_then(Value::as_u64).is_none()
        || snapshot
            .get("providers")
            .and_then(Value::as_array)
            .is_none()
        || snapshot
            .get("refreshErrors")
            .and_then(Value::as_array)
            .is_none()
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    // A manual-only report must never ride on a non-ok outcome.
    if result.get("outcome").and_then(Value::as_str) != Some("ok") && result.contains_key("refresh")
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    serde_json::from_value::<CatalogCommandResultWire>(Value::Object(result.clone()))
        .map_err(|_| ConnectionFailure::ProtocolError)
}

/// Ticket 14: alias registry command session — same negotiation as the
/// models/catalog commands; the command payload is the versioned
/// alias_command wire and the result decodes strictly (allowlisted
/// outcomes, value-free errors). Thin transport only.
async fn execute_alias_command_session(
    pipe_name: &str,
    capability: String,
    command: AliasCommand,
) -> Result<AliasCommandResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "alias_command",
                    "requestId": command.request_id(),
                    "command": command.wire(),
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_alias_command_result(&result, &command)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_alias_command_result(
    value: &Value,
    command: &AliasCommand,
) -> Result<AliasCommandResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("alias_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    if !matches!(
        result.get("outcome").and_then(Value::as_str),
        Some("ok" | "conflict" | "invalid" | "storage_failure")
    ) {
        return Err(ConnectionFailure::ProtocolError);
    }
    if result.get("state").and_then(Value::as_object).is_none() {
        return Err(ConnectionFailure::ProtocolError);
    }
    serde_json::from_value::<AliasCommandResultWire>(Value::Object(result.clone()))
        .map_err(|_| ConnectionFailure::ProtocolError)
}

fn valid_masked_scopes(value: Option<&Value>) -> bool {
    let Some(scopes) = value.and_then(Value::as_array) else {
        return false;
    };
    scopes.iter().all(|scope| {
        let Some(scope) = scope.as_object() else {
            return false;
        };
        let scope_type = scope.get("type").and_then(Value::as_str);
        let masked = scope.get("maskedToken").and_then(Value::as_str);
        // The mask marker guarantees a masked field never carries a raw token.
        matches!(scope_type, Some("global" | "project"))
            && masked.is_some_and(|value| !value.is_empty() && value.contains('\u{2026}'))
            && match scope_type {
                Some("global") => scope.get("projectDir").is_none(),
                Some("project") => scope
                    .get("projectDir")
                    .and_then(Value::as_str)
                    .is_some_and(|dir| !dir.is_empty()),
                _ => false,
            }
    })
}

async fn execute_diagnostics_warnings_session(
    pipe_name: &str,
    capability: String,
) -> Result<Vec<DiagnosticsWarningWire>, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "get_diagnostics",
                    "requestId": "desktop-diagnostics-warnings",
                    "query": {
                        "minimumLevel": "warning",
                        "limit": 8,
                    },
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_diagnostics_warnings(&result)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

fn decode_diagnostics_warnings(
    value: &Value,
) -> Result<Vec<DiagnosticsWarningWire>, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("diagnostics_result")
        || value.get("requestId").and_then(Value::as_str) != Some("desktop-diagnostics-warnings")
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    let records = result.get("records").and_then(Value::as_array);
    let Some(records) = records else {
        return Err(ConnectionFailure::ProtocolError);
    };
    let mut warnings = Vec::with_capacity(records.len());
    for record in records {
        let Some(record) = record.as_object() else {
            return Err(ConnectionFailure::ProtocolError);
        };
        let Some(id) = record.get("id").and_then(Value::as_u64) else {
            return Err(ConnectionFailure::ProtocolError);
        };
        let Some(level) = record.get("level").and_then(Value::as_str) else {
            return Err(ConnectionFailure::ProtocolError);
        };
        if !matches!(level, "warning" | "error" | "critical") {
            return Err(ConnectionFailure::ProtocolError);
        }
        let Some(time) = record.get("time").and_then(Value::as_u64) else {
            return Err(ConnectionFailure::ProtocolError);
        };
        let Some(text) = record.get("text").and_then(Value::as_str) else {
            return Err(ConnectionFailure::ProtocolError);
        };
        // Only the allowlisted safe fields are forwarded; details, errors,
        // fingerprints, and request ids never reach the renderer.
        warnings.push(DiagnosticsWarningWire {
            id,
            level: level.to_owned(),
            time,
            text: text.to_owned(),
        });
    }
    Ok(warnings)
}

async fn execute_request_identities_session(
    pipe_name: &str,
    capability: String,
) -> Result<Vec<RequestIdentityRecordWire>, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "get_request_identities",
                    "requestId": "desktop-request-identities",
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_request_identities(&result)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// One-shot bounded Request Ledger query (Ticket 19): negotiate, send the
/// query verbatim (the native shell never interprets filters — the host
/// validates them), and expect exactly one result frame.
async fn execute_request_ledger_query_session(
    pipe_name: &str,
    capability: String,
    query: Option<Value>,
) -> Result<RequestLedgerResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            let mut frame =
                json!({ "type": "get_request_ledger", "requestId": "desktop-request-ledger" });
            if let Some(query) = query {
                frame["query"] = query;
            }
            write_json_frame(&mut pipe, &frame)
                .await
                .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_request_ledger_result(&result)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// The long-lived Request Ledger subscription session (Ticket 19): holds
/// the pipe write half so the subscription stays open; dropping the session
/// aborts the reader loop and closes the pipe, so a replaced or shut-down
/// subscription can never keep forwarding events and the Control Plane host
/// sees the connection loss and stops the per-connection fan-out. The
/// session carries its correlation id for identity-safe cleanup.
pub(crate) struct RequestLedgerSession {
    request_id: String,
    cancel: Arc<Notify>,
    _write: tokio::io::WriteHalf<NamedPipeClient>,
}

impl Drop for RequestLedgerSession {
    fn drop(&mut self) {
        self.cancel.notify_one();
    }
}

impl RequestLedgerSession {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }
}

/// The start of one ledger subscription: the shared session handle plus the
/// reader-end signal, resolved once the reader loop exits (cancel, pipe
/// close, or a protocol error).
pub(crate) struct RequestLedgerSubscribeStart {
    pub(crate) session: RequestLedgerSession,
    pub(crate) ended: oneshot::Receiver<()>,
}

/// Long-lived ledger subscription (Ticket 19): negotiate, send
/// `ledger_subscribe`, wait for the host's `subscribed` confirmation (the
/// listen-first barrier), then hand the pipe to a reader loop that forwards
/// allowlisted committed records to the emitter until the session is
/// dropped or the connection dies.
pub(crate) async fn execute_request_ledger_subscribe_session(
    pipe_name: &str,
    capability: String,
    request_id: String,
    on_ledger_event: impl FnMut(Value) + Send + 'static,
) -> Result<RequestLedgerSubscribeStart, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({
                    "type": "ledger_subscribe",
                    "requestId": "desktop-ledger-subscribe",
                }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let confirmation = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            if confirmation.get("type").and_then(Value::as_str) != Some("subscribed")
                || confirmation.get("requestId").and_then(Value::as_str)
                    != Some("desktop-ledger-subscribe")
            {
                return Err(ConnectionFailure::ProtocolError);
            }
            let (read, write) = split(pipe);
            let cancel = Arc::new(Notify::new());
            let (ended_sender, ended_receiver) = oneshot::channel();
            tokio::spawn(request_ledger_reader(
                read,
                cancel.clone(),
                on_ledger_event,
                ended_sender,
            ));
            Ok(RequestLedgerSubscribeStart {
                session: RequestLedgerSession {
                    request_id,
                    cancel,
                    _write: write,
                },
                ended: ended_receiver,
            })
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// The ledger reader loop: forwards strictly decoded committed records to
/// the emitter; any other frame (including a malformed or secret-bearing
/// record extension) is a protocol error. A closed pipe ends the
/// subscription (the host stops the fan-out on connection loss). The
/// cancellation notify aborts the loop when the session is replaced or the
/// shell shuts down, so a dead subscription never keeps forwarding events.
async fn request_ledger_reader<R>(
    mut read: R,
    cancel: Arc<Notify>,
    mut on_ledger_event: impl FnMut(Value) + Send + 'static,
    ended_sender: oneshot::Sender<()>,
) where
    R: AsyncRead + Unpin,
{
    loop {
        tokio::select! {
            _ = cancel.notified() => {
                let _ = ended_sender.send(());
                return;
            }
            frame = read_json_frame(&mut read) => {
                let record = match frame {
                    Err(_) => None,
                    Ok(value) => {
                        let mut record = None;
                        if value.get("type").and_then(Value::as_str) == Some("event") {
                            if let Some(event) = value.get("event") {
                                if event.get("type").and_then(Value::as_str)
                                    == Some("request_ledger")
                                {
                                    record = event
                                        .get("record")
                                        .and_then(decode_request_ledger_record);
                                }
                            }
                        }
                        record
                    }
                };
                match record {
                    Some(record) => {
                        on_ledger_event(serde_json::to_value(record).expect("serializable"));
                    }
                    None => {
                        let _ = ended_sender.send(());
                        return;
                    }
                }
            }
        }
    }
}

/// Strict identity record decode: the allowed key set has no
/// effective-session field, so a record that ever carries the internal
/// `effectiveSessionId` (or any other unknown key) is rejected instead of
/// projected.
fn decode_request_identities(
    value: &Value,
) -> Result<Vec<RequestIdentityRecordWire>, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("request_identities_result")
        || value.get("requestId").and_then(Value::as_str) != Some("desktop-request-identities")
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    let records = result.get("records").and_then(Value::as_array);
    let Some(records) = records else {
        return Err(ConnectionFailure::ProtocolError);
    };
    let allowed: &[&str] = &["id", "time", "protocolId", "clientSessionId", "projectDir"];
    let uuid_pattern = regex_lite();
    let mut output = Vec::with_capacity(records.len());
    for record in records {
        let Some(record) = record.as_object() else {
            return Err(ConnectionFailure::ProtocolError);
        };
        if record.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(ConnectionFailure::ProtocolError);
        }
        let Some(id) = record.get("id").and_then(Value::as_u64) else {
            return Err(ConnectionFailure::ProtocolError);
        };
        let Some(time) = record.get("time").and_then(Value::as_u64) else {
            return Err(ConnectionFailure::ProtocolError);
        };
        let Some(protocol_id) = record.get("protocolId").and_then(Value::as_str) else {
            return Err(ConnectionFailure::ProtocolError);
        };
        if protocol_id.is_empty() {
            return Err(ConnectionFailure::ProtocolError);
        }
        let client_session_id = record.get("clientSessionId").and_then(Value::as_str);
        if client_session_id.is_some_and(|value| !uuid_pattern(value)) {
            return Err(ConnectionFailure::ProtocolError);
        }
        let project_dir = record.get("projectDir").and_then(Value::as_str);
        if project_dir.is_some_and(str::is_empty) {
            return Err(ConnectionFailure::ProtocolError);
        }
        output.push(RequestIdentityRecordWire {
            id,
            time,
            protocol_id: protocol_id.to_owned(),
            client_session_id: client_session_id.map(str::to_owned),
            project_dir: project_dir.map(str::to_owned),
        });
    }
    Ok(output)
}

/// Strict ledger record decode (Ticket 19): the allowlisted key set is
/// exact, every identity field is validated against the UUID grammar under
/// its own key (the effective identity can never be smuggled into the
/// client-session field), strings are bounded, timestamps/status follow the
/// wire contract, and `facts` must be a JSON object (its allowlisted
/// sub-keys are re-decoded strictly by the renderer). A record that ever
/// carries an unknown key or out-of-contract value is rejected, never
/// projected. No status, speed, filter, or usage semantics are derived
/// here.
fn decode_request_ledger_record(value: &Value) -> Option<RequestLedgerRecordWire> {
    let record = value.as_object()?;
    const ALLOWED: &[&str] = &[
        "id",
        "requestId",
        "protocolId",
        "phase",
        "outcome",
        "acceptedAt",
        "executionStartedAt",
        "terminalAt",
        "completedAt",
        "clientHttpStatus",
        "externalAlias",
        "providerId",
        "realModelId",
        "clientSessionId",
        "effectiveSessionId",
        "projectDir",
        "facts",
        "terminalUsage",
    ];
    if record.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return None;
    }
    let id = record.get("id").and_then(Value::as_u64)?;
    if id < 1 {
        return None;
    }
    let request_id = record.get("requestId").and_then(Value::as_str)?;
    let uuid_pattern = regex_lite();
    if !uuid_pattern(request_id) {
        return None;
    }
    let protocol_id = record.get("protocolId").and_then(Value::as_str)?;
    if protocol_id.is_empty() || protocol_id.len() > 128 {
        return None;
    }
    let phase = record.get("phase").and_then(Value::as_str)?;
    if !matches!(
        phase,
        "accepted" | "execution" | "rendering" | "terminal-preparation"
    ) {
        return None;
    }
    let outcome = record.get("outcome").and_then(Value::as_str)?;
    if !matches!(
        outcome,
        "running"
            | "success"
            | "failed"
            | "aborted"
            | "rejected-auth"
            | "unknown-alias"
            | "unavailable-alias"
            | "interrupted"
    ) {
        return None;
    }
    let accepted_at = record.get("acceptedAt").and_then(Value::as_u64)?;
    let execution_started_at = record.get("executionStartedAt").and_then(Value::as_u64);
    let terminal_at = record.get("terminalAt").and_then(Value::as_u64);
    let completed_at = record.get("completedAt").and_then(Value::as_u64);
    let client_http_status = record.get("clientHttpStatus").and_then(Value::as_u64);
    if client_http_status.is_some_and(|status| !(100..=599).contains(&status)) {
        return None;
    }
    let external_alias = record.get("externalAlias").and_then(Value::as_str);
    if external_alias.is_some_and(|value| value.is_empty() || value.len() > 4_096) {
        return None;
    }
    let provider_id = record.get("providerId").and_then(Value::as_str);
    if provider_id.is_some_and(|value| value.is_empty() || value.len() > 256) {
        return None;
    }
    let real_model_id = record.get("realModelId").and_then(Value::as_str);
    if real_model_id.is_some_and(|value| value.is_empty() || value.len() > 256) {
        return None;
    }
    let client_session_id = record.get("clientSessionId").and_then(Value::as_str);
    if client_session_id.is_some_and(|value| !uuid_pattern(value)) {
        return None;
    }
    let effective_session_id = record.get("effectiveSessionId").and_then(Value::as_str);
    if effective_session_id.is_some_and(|value| !uuid_pattern(value)) {
        return None;
    }
    let project_dir = record.get("projectDir").and_then(Value::as_str);
    if project_dir.is_some_and(|value| value.is_empty() || value.len() > 1_024) {
        return None;
    }
    let facts = record.get("facts");
    if facts.is_some_and(|value| !value.is_object()) {
        return None;
    }
    // The canonical terminal-usage snapshot (Ticket 20) rides opaque like
    // facts: the native shell never derives usage semantics — the renderer
    // strict-decodes its allowlisted sub-keys.
    let terminal_usage = record.get("terminalUsage");
    if terminal_usage.is_some_and(|value| !value.is_object()) {
        return None;
    }
    Some(RequestLedgerRecordWire {
        id,
        request_id: request_id.to_owned(),
        protocol_id: protocol_id.to_owned(),
        phase: phase.to_owned(),
        outcome: outcome.to_owned(),
        accepted_at,
        execution_started_at,
        terminal_at,
        completed_at,
        client_http_status,
        external_alias: external_alias.map(str::to_owned),
        provider_id: provider_id.map(str::to_owned),
        real_model_id: real_model_id.map(str::to_owned),
        client_session_id: client_session_id.map(str::to_owned),
        effective_session_id: effective_session_id.map(str::to_owned),
        project_dir: project_dir.map(str::to_owned),
        facts: facts.cloned(),
        terminal_usage: terminal_usage.cloned(),
    })
}

/// One-shot versioned analytics query (Ticket 21): negotiate, send
/// `get_analytics` with the query forwarded verbatim, and strict-decode the
/// result envelope. The host already normalized the query; the native shell
/// never interprets aggregates.
async fn execute_analytics_query_session(
    pipe_name: &str,
    capability: String,
    query: Value,
) -> Result<AnalyticsResultWire, ConnectionFailure> {
    let mut pipe = ClientOptions::new()
        .open(pipe_name)
        .map_err(|_| ConnectionFailure::PipeUnavailable)?;
    write_json_frame(
        &mut pipe,
        &json!({
            "type": "hello",
            "requestId": "desktop-hello",
            "contractVersion": CONTROL_PLANE_VERSION,
            "capability": capability,
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let hello = read_json_frame(&mut pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    match decode_hello(&hello)? {
        Hello::Compatible { .. } => {
            write_json_frame(
                &mut pipe,
                &json!({ "type": "get_analytics", "requestId": "desktop-analytics", "query": query }),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let result = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            decode_analytics_result(&result)
        }
        Hello::Incompatible { .. } => Err(ConnectionFailure::ProtocolError),
    }
}

/// Strict analytics result decode (Ticket 21): the frame header, the exact
/// result key set, the fixed version, the command vocabulary, and the
/// command's required sub-shapes. Unknown keys — including any monetary
/// field, which has no key in the contract — reject the frame; nested
/// aggregates ride opaque for the renderer's strict allowlist decoder.
fn decode_analytics_result(value: &Value) -> Result<AnalyticsResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("analytics_result")
        || value.get("requestId").and_then(Value::as_str) != Some("desktop-analytics")
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    const ALLOWED: &[&str] = &[
        "version",
        "command",
        "totals",
        "rows",
        "truncated",
        "omittedGroupCount",
        "omittedGroupRequests",
        "buckets",
        "providers",
        "models",
        "protocols",
        "projects",
        "outcomes",
    ];
    if result.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(ConnectionFailure::ProtocolError);
    }
    let version = result.get("version").and_then(Value::as_u64);
    if version != Some(1) {
        return Err(ConnectionFailure::ProtocolError);
    }
    let command = result.get("command").and_then(Value::as_str);
    let Some(command) = command else {
        return Err(ConnectionFailure::ProtocolError);
    };
    if command == "summary" {
        let totals = result.get("totals").and_then(Value::as_object);
        if totals.is_none() {
            return Err(ConnectionFailure::ProtocolError);
        }
        let rows = result.get("rows");
        if let Some(rows) = rows {
            let rows = rows.as_array().ok_or(ConnectionFailure::ProtocolError)?;
            if rows.is_empty() || rows.iter().any(|row| !row.is_object()) {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        let buckets = result.get("buckets");
        if let Some(buckets) = buckets {
            let buckets = buckets.as_array().ok_or(ConnectionFailure::ProtocolError)?;
            if buckets.is_empty() || buckets.iter().any(|bucket| !bucket.is_object()) {
                return Err(ConnectionFailure::ProtocolError);
            }
        }
        let truncated = result.get("truncated").and_then(Value::as_bool);
        if result.get("truncated").is_some() && truncated.is_none() {
            return Err(ConnectionFailure::ProtocolError);
        }
        let omitted_group_count = result.get("omittedGroupCount").and_then(Value::as_u64);
        if result.get("omittedGroupCount").is_some() && omitted_group_count.is_none() {
            return Err(ConnectionFailure::ProtocolError);
        }
        let omitted_group_requests = result.get("omittedGroupRequests").and_then(Value::as_u64);
        if result.get("omittedGroupRequests").is_some() && omitted_group_requests.is_none() {
            return Err(ConnectionFailure::ProtocolError);
        }
        return Ok(AnalyticsResultWire {
            version: 1,
            command: "summary".to_owned(),
            totals: result.get("totals").cloned(),
            rows: result
                .get("rows")
                .map(|rows| rows.as_array().cloned().unwrap_or_default()),
            truncated,
            omitted_group_count,
            omitted_group_requests,
            buckets: result
                .get("buckets")
                .map(|buckets| buckets.as_array().cloned().unwrap_or_default()),
            providers: None,
            models: None,
            protocols: None,
            projects: None,
            outcomes: None,
        });
    }
    if command == "options" {
        let bounded = |key: &str| -> Result<Vec<String>, ConnectionFailure> {
            let values = result
                .get(key)
                .and_then(Value::as_array)
                .ok_or(ConnectionFailure::ProtocolError)?;
            if values.len() > 64 {
                return Err(ConnectionFailure::ProtocolError);
            }
            let mut output = Vec::with_capacity(values.len());
            for entry in values {
                let text = entry.as_str().ok_or(ConnectionFailure::ProtocolError)?;
                if text.is_empty() || text.len() > 1_024 {
                    return Err(ConnectionFailure::ProtocolError);
                }
                output.push(text.to_owned());
            }
            Ok(output)
        };
        let truncated = result.get("truncated").and_then(Value::as_bool);
        if result.get("truncated").is_some() && truncated.is_none() {
            return Err(ConnectionFailure::ProtocolError);
        }
        return Ok(AnalyticsResultWire {
            version: 1,
            command: "options".to_owned(),
            totals: None,
            rows: None,
            truncated,
            omitted_group_count: None,
            omitted_group_requests: None,
            buckets: None,
            providers: Some(bounded("providers")?),
            models: Some(bounded("models")?),
            protocols: Some(bounded("protocols")?),
            projects: Some(bounded("projects")?),
            outcomes: Some(bounded("outcomes")?),
        });
    }
    Err(ConnectionFailure::ProtocolError)
}

/// Strict ledger query-result decode: the type/requestId frame header plus
/// the allowlisted records.
fn decode_request_ledger_result(
    value: &Value,
) -> Result<RequestLedgerResultWire, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("request_ledger_result")
        || value.get("requestId").and_then(Value::as_str) != Some("desktop-request-ledger")
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    let has_more = result.get("hasMore").and_then(Value::as_bool);
    let Some(has_more) = has_more else {
        return Err(ConnectionFailure::ProtocolError);
    };
    let records = result.get("records").and_then(Value::as_array);
    let Some(records) = records else {
        return Err(ConnectionFailure::ProtocolError);
    };
    let mut output = Vec::with_capacity(records.len());
    for record in records {
        let record =
            decode_request_ledger_record(record).ok_or(ConnectionFailure::ProtocolError)?;
        output.push(record);
    }
    Ok(RequestLedgerResultWire {
        records: output,
        has_more,
    })
}

/// Minimal UUID-shape matcher (version 1-8 variant). Kept as a tiny local
/// matcher so the shell does not pull a regex dependency for one check.
fn regex_lite() -> impl Fn(&str) -> bool {
    fn is_hex(byte: u8) -> bool {
        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || (b'A'..=b'F').contains(&byte)
    }
    move |value: &str| {
        let bytes = value.as_bytes();
        bytes.len() == 36
            && bytes[8] == b'-'
            && bytes[13] == b'-'
            && bytes[18] == b'-'
            && bytes[23] == b'-'
            && bytes[0..8].iter().all(|b| is_hex(*b))
            && bytes[9..13].iter().all(|b| is_hex(*b))
            && bytes[14] >= b'1'
            && bytes[14] <= b'8'
            && bytes[15..18].iter().all(|b| is_hex(*b))
            && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
            && bytes[20..23].iter().all(|b| is_hex(*b))
            && bytes[24..36].iter().all(|b| is_hex(*b))
    }
}

async fn execute_runtime_command<W>(
    pipe: &mut W,
    command: RuntimeCommand,
) -> Result<StatusSnapshot, ConnectionFailure>
where
    W: AsyncRead + AsyncWrite + Unpin,
{
    write_json_frame(
        pipe,
        &json!({
            "type": "runtime_command",
            "requestId": command.request_id(),
            "command": command.as_str(),
        }),
    )
    .await
    .map_err(FrameFailure::connection_failure)?;
    let result = read_json_frame(pipe)
        .await
        .map_err(FrameFailure::connection_failure)?;
    decode_runtime_command_result(&result, command)
}

enum Hello {
    Compatible {
        application_version: String,
    },
    Incompatible {
        requested_version: u64,
        supported_versions: Vec<u64>,
    },
}

fn decode_hello(value: &Value) -> Result<Hello, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("hello_result")
        || value.get("requestId").and_then(Value::as_str) != Some("desktop-hello")
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    match result.get("type").and_then(Value::as_str) {
        Some("compatible")
            if result.get("contractVersion").and_then(Value::as_u64)
                == Some(CONTROL_PLANE_VERSION) =>
        {
            let application = result
                .get("application")
                .and_then(Value::as_object)
                .ok_or(ConnectionFailure::ProtocolError)?;
            if application.get("id").and_then(Value::as_str) != Some("luckytoken") {
                return Err(ConnectionFailure::ProtocolError);
            }
            let version = application
                .get("version")
                .and_then(Value::as_str)
                .ok_or(ConnectionFailure::ProtocolError)?;
            Ok(Hello::Compatible {
                application_version: version.to_owned(),
            })
        }
        Some("incompatible") => {
            let requested_version = result
                .get("requestedVersion")
                .and_then(Value::as_u64)
                .ok_or(ConnectionFailure::ProtocolError)?;
            let supported_versions = result
                .get("supportedVersions")
                .and_then(Value::as_array)
                .ok_or(ConnectionFailure::ProtocolError)?
                .iter()
                .map(|version| version.as_u64().ok_or(ConnectionFailure::ProtocolError))
                .collect::<Result<Vec<_>, _>>()?;
            if supported_versions.is_empty() {
                return Err(ConnectionFailure::ProtocolError);
            }
            Ok(Hello::Incompatible {
                requested_version,
                supported_versions,
            })
        }
        _ => Err(ConnectionFailure::ProtocolError),
    }
}

/// Ticket 23: audit-unavailable projection (fixed text only; the shell and
/// tray render fixed labels from these flags, never dynamic content).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct PersistenceAuthorityProjectionWire {
    pub(crate) authority: String,
    pub(crate) since: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct PersistenceProjectionWire {
    #[serde(rename = "auditUnavailable")]
    pub(crate) audit_unavailable: bool,
    pub(crate) acknowledged: bool,
    pub(crate) authorities: Vec<PersistenceAuthorityProjectionWire>,
}

#[derive(Deserialize)]
struct StatusSnapshotWire {
    sequence: u64,
    #[serde(rename = "modelDataPlane")]
    model_data_plane: ModelDataPlaneState,
    provider: ProviderState,
    #[serde(rename = "dataPlane")]
    data_plane: Option<DataPlaneStatusWire>,
    settings: Option<BTreeMap<String, RegisteredSettingWire>>,
    confirmation: Option<LanConfirmationWire>,
    ownership: Option<OwnershipWire>,

    models: Option<ModelsProjectionWire>,
    aliases: Option<AliasesProjectionWire>,
    credentials: Option<CredentialProjectionWire>,
    persistence: Option<PersistenceProjectionWire>,
}

#[derive(Deserialize)]
struct DataPlaneStatusWire {
    #[serde(rename = "configuredOrigin")]
    configured_origin: String,
    #[serde(rename = "configuredPort")]
    configured_port: u16,
    failure: Option<DataPlaneFailureWire>,
}

#[derive(Deserialize)]
struct DataPlaneFailureWire {
    code: DataPlaneFailureCode,
}

fn decode_status_snapshot(value: &Value) -> Option<StatusSnapshot> {
    let wire: StatusSnapshotWire = serde_json::from_value(value.clone()).ok()?;
    if wire.data_plane.as_ref().is_some_and(|data_plane| {
        !configured_origin_matches_port(&data_plane.configured_origin, data_plane.configured_port)
    }) {
        return None;
    }
    let data_plane = wire.data_plane.map(|data_plane| DataPlaneStatus {
        configured_origin: data_plane.configured_origin,
        configured_port: data_plane.configured_port,
        failure: data_plane.failure.map(|failure| DataPlaneFailure {
            code: failure.code,
            message: match failure.code {
                DataPlaneFailureCode::PortInUse => "The configured port is already in use. Stop the other application or choose a different port.",
                DataPlaneFailureCode::StartFailed => "The model gateway could not start. Check its configured address and try again.",
                DataPlaneFailureCode::StopFailed => "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
            }
            .to_owned(),
        }),
    });
    let has_failure = data_plane
        .as_ref()
        .and_then(|data_plane| data_plane.failure.as_ref())
        .is_some();
    if (wire.model_data_plane == ModelDataPlaneState::Failed) != has_failure {
        return None;
    }
    Some(StatusSnapshot {
        sequence: wire.sequence,
        model_data_plane: wire.model_data_plane,
        provider: wire.provider,
        data_plane,
        settings: wire.settings.filter(|settings| !settings.is_empty()),
        confirmation: wire.confirmation,
        ownership: wire.ownership,

        models: wire.models,
        aliases: wire.aliases,
        credentials: wire.credentials,
        persistence: wire.persistence.filter(|projection| {
            // Strict: a projection must be an actual audit-unavailable state.
            projection.audit_unavailable && !projection.authorities.is_empty()
        }),
    })
}

fn configured_origin_matches_port(origin: &str, port: u16) -> bool {
    let Some(authority) = origin.strip_prefix("http://") else {
        return false;
    };
    if authority.contains(['/', '?', '#', '@']) {
        return false;
    }
    authority
        .rsplit_once(':')
        .and_then(|(_, value)| value.parse::<u16>().ok())
        == Some(port)
}

fn decode_runtime_command_result(
    value: &Value,
    command: RuntimeCommand,
) -> Result<StatusSnapshot, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("runtime_command_result")
        || value.get("requestId").and_then(Value::as_str) != Some(command.request_id())
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(ConnectionFailure::ProtocolError)?;
    if result.get("command").and_then(Value::as_str) != Some(command.as_str())
        || !matches!(
            result.get("outcome").and_then(Value::as_str),
            Some("completed" | "unchanged" | "failed" | "conflict")
        )
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    result
        .get("snapshot")
        .and_then(decode_status_snapshot)
        .ok_or(ConnectionFailure::ProtocolError)
}

fn decode_status_event(value: &Value) -> Option<StatusSnapshot> {
    if value.get("type").and_then(Value::as_str) != Some("event") {
        return None;
    }
    let event = value.get("event")?;
    if event.get("type").and_then(Value::as_str) != Some("status_changed") {
        return None;
    }
    let sequence = event.get("sequence").and_then(Value::as_u64)?;
    let snapshot = decode_status_snapshot(event.get("snapshot")?)?;
    (snapshot.sequence == sequence).then_some(snapshot)
}

/// Recognizes a well-formed Control Plane `event` frame whose inner event is
/// typed but not `status_changed` (e.g. Ticket 07 diagnostics events). Such
/// frames are foreign to the status-only subscription and are skipped, never
/// consumed or treated as protocol errors.
fn decode_foreign_event(value: &Value) -> Option<()> {
    if value.get("type").and_then(Value::as_str) != Some("event") {
        return None;
    }
    let event = value.get("event")?;
    let event_type = event.get("type").and_then(Value::as_str)?;
    (event_type != "status_changed").then_some(())
}

#[derive(Clone, Copy)]
enum FrameFailure {
    Io,
    Protocol,
}

impl FrameFailure {
    fn connection_failure(self) -> ConnectionFailure {
        match self {
            Self::Io => ConnectionFailure::PipeUnavailable,
            Self::Protocol => ConnectionFailure::ProtocolError,
        }
    }
}

async fn write_json_frame<W>(writer: &mut W, value: &Value) -> Result<(), FrameFailure>
where
    W: AsyncWrite + Unpin,
{
    let body = serde_json::to_vec(value).map_err(|_| FrameFailure::Protocol)?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameFailure::Protocol);
    }
    writer
        .write_all(&(body.len() as u32).to_be_bytes())
        .await
        .map_err(|_| FrameFailure::Io)?;
    writer.write_all(&body).await.map_err(|_| FrameFailure::Io)
}

async fn read_json_frame<R>(reader: &mut R) -> Result<Value, FrameFailure>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; 4];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|_| FrameFailure::Io)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(FrameFailure::Protocol);
    }
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| FrameFailure::Io)?;
    serde_json::from_slice(&body).map_err(|_| FrameFailure::Protocol)
}

#[cfg(test)]
use tokio::net::windows::named_pipe::NamedPipeServer;

#[cfg(test)]
fn test_pipe_name() -> String {
    format!(
        r"\\.\pipe\luckytoken-desktop-test-{}-{}",
        std::process::id(),
        rand_test_suffix()
    )
}

#[cfg(test)]
fn rand_test_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the epoch")
        .as_nanos() as u64;
    // Parallel tests in one binary share the process id and can observe
    // the same nanosecond; a per-call counter makes every pipe name
    // unique so `first_pipe_instance` never collides across tests.
    nanos ^ COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
async fn read_frame_length(reader: &mut NamedPipeServer) -> Result<usize, std::io::Error> {
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header).await?;
    Ok(u32::from_be_bytes(header) as usize)
}

#[cfg(test)]
async fn write_frame_bytes(
    writer: &mut NamedPipeServer,
    value: &Value,
) -> Result<(), std::io::Error> {
    let body = serde_json::to_vec(value).map_err(|_| std::io::ErrorKind::InvalidData)?;
    writer.write_all(&(body.len() as u32).to_be_bytes()).await?;
    writer.write_all(&body).await
}

#[cfg(test)]
struct TestPipeServer {
    server: NamedPipeServer,
}

#[cfg(test)]
impl TestPipeServer {
    async fn next_frame(&mut self) -> Value {
        let length = read_frame_length(&mut self.server)
            .await
            .expect("test server must read a frame header");
        let mut body = vec![0_u8; length];
        self.server
            .read_exact(&mut body)
            .await
            .expect("test server must read a frame body");
        serde_json::from_slice(&body).expect("test server must parse the frame body")
    }

    async fn send(&mut self, value: &Value) {
        write_frame_bytes(&mut self.server, value)
            .await
            .expect("test server must write a frame");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::{net::windows::named_pipe::ServerOptions, time::timeout};

    #[tokio::test]
    async fn reconnect_session_must_begin_with_get_status_and_never_auto_start() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");

        // A reconnecting subscription session (renderer Retry) must query
        // status and subscribe; the automatic Start belongs to the one-shot
        // native lifecycle gate and never fires again on reconnect.
        let session_task = tokio::spawn(async move {
            connect_session(&pipe_name, "desktop-test-capability".to_owned(), false)
                .await
                .expect("reconnect session must negotiate a compatible hello")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        assert_eq!(
            hello.get("requestId").and_then(Value::as_str),
            Some("desktop-hello")
        );
        assert_eq!(
            hello.get("contractVersion").and_then(Value::as_u64),
            Some(CONTROL_PLANE_VERSION)
        );
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let first = server.next_frame().await;
        assert_eq!(
            first.get("type").and_then(Value::as_str),
            Some("get_status"),
            "the first reconnect request must be get_status, never runtime_command start"
        );
        assert_eq!(
            first.get("requestId").and_then(Value::as_str),
            Some("desktop-status")
        );
        server
            .send(&json!({
                "type": "status_result",
                "requestId": "desktop-status",
                "snapshot": {
                    "sequence": 2,
                    "modelDataPlane": "running",
                    "provider": "unconfigured",
                    "dataPlane": {
                        "configuredOrigin": "http://127.0.0.1:3000",
                        "configuredPort": 3000
                    }
                }
            }))
            .await;

        let second = server.next_frame().await;
        assert_eq!(
            second.get("type").and_then(Value::as_str),
            Some("subscribe")
        );
        assert_eq!(
            second.get("requestId").and_then(Value::as_str),
            Some("desktop-subscribe")
        );
        server
            .send(&json!({"type": "subscribed", "requestId": "desktop-subscribe"}))
            .await;

        let session = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("reconnect session must complete within the timeout")
            .expect("reconnect session task must not panic");
        let ConnectResult::Connected(session) = session else {
            panic!("reconnect must produce a connected session");
        };
        assert_eq!(session.application_version(), "native-test");
        assert_eq!(session.snapshot().sequence, 2);
    }

    #[tokio::test]
    async fn settings_command_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_settings_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                SettingsCommand::Query,
            )
            .await
            .expect("settings query must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        assert_eq!(
            hello.get("contractVersion").and_then(Value::as_u64),
            Some(CONTROL_PLANE_VERSION)
        );
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("settings_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-settings-query")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("query")
        );
        server
            .send(&json!({
                "type": "settings_command_result",
                "requestId": "desktop-settings-query",
                "result": {
                    "outcome": "ok",
                    "settings": {
                        "protocols.anthropic-messages.enabled": {
                            "key": "protocols.anthropic-messages.enabled",
                            "type": "boolean",
                            "default": true,
                            "validation": {"type": "boolean"},
                            "sensitivity": "public",
                            "applyMode": "hot-apply",
                            "value": true
                        }
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("settings query must complete within the timeout")
            .expect("settings query task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(
            result
                .settings
                .get("protocols.anthropic-messages.enabled")
                .map(|setting| setting.key.as_str()),
            Some("protocols.anthropic-messages.enabled")
        );
    }

    #[tokio::test]
    async fn history_query_exchanges_the_versioned_wire_and_returns_only_the_allowlisted_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_history_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                HistoryCommand::Query {
                    range: Some(json!({ "fromMs": 1000, "toMs": 2000 })),
                },
            )
            .await
            .expect("history query must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(request["type"], "history_query");
        assert_eq!(request["requestId"], "desktop-history-query");
        assert_eq!(request["range"]["fromMs"], 1000);
        server
            .send(&json!({
                "type": "history_query_result",
                "requestId": "desktop-history-query",
                "result": {
                    "range": {"fromMs": 1000, "toMs": 2000},
                    "counts": {"requestLedger": 4, "diagnostics": 3, "capture": 2},
                    "credentialCanary": "must-not-reach-renderer"
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("history query must complete within the timeout")
            .expect("history query task must not panic");
        let HistoryCommandResultWire::Query(result) = result else {
            panic!("history query must return a query result");
        };
        assert_eq!(result.counts.request_ledger, 4);
        assert_eq!(result.counts.diagnostics, 3);
        assert_eq!(result.counts.capture, 2);
        let projected = serde_json::to_value(result).expect("result must serialize");
        assert!(projected.get("credentialCanary").is_none());
    }

    #[tokio::test]
    async fn history_export_projects_a_sensitive_manifest_without_unrelated_fields() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_history_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                HistoryCommand::Export {
                    command: json!({
                        "range": "all",
                        "capture": "included",
                        "destinationPath": "C:\\exports\\history.json",
                        "overwrite": false
                    }),
                },
            )
            .await
            .expect("history export must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };
        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(request["type"], "history_export_command");
        assert_eq!(request["requestId"], "desktop-history-export");
        assert_eq!(request["command"]["capture"], "included");
        server
            .send(&json!({
                "type": "history_export_result",
                "requestId": "desktop-history-export",
                "result": {
                    "outcome": "ok",
                    "exportId": "export-001",
                    "destinationPath": "C:\\exports\\history.json",
                    "manifest": {
                        "manifestVersion": 1,
                        "exportedAt": 1_756_000_000_000_u64,
                        "sensitive": true,
                        "auditUnavailable": false,
                        "sources": {
                            "requestLedger": {"schemaVersion": 2, "count": 4},
                            "diagnostics": {"schemaVersion": 1, "count": 3},
                            "capture": {"included": true, "schemaVersion": 1, "count": 2}
                        }
                    },
                    "credentialCanary": "must-not-reach-renderer"
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("history export must complete within the timeout")
            .expect("history export task must not panic");
        let HistoryCommandResultWire::Export(result) = result else {
            panic!("history export must return an export result");
        };
        assert_eq!(result.outcome, "ok");
        assert!(result
            .manifest
            .as_ref()
            .is_some_and(|manifest| manifest.sensitive));
        let projected = serde_json::to_value(result).expect("result must serialize");
        assert!(projected.get("credentialCanary").is_none());
    }

    #[tokio::test]
    async fn history_delete_projects_truthful_per_authority_partial_failure() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_history_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                HistoryCommand::Delete {
                    command: json!({ "range": "all" }),
                },
            )
            .await
            .expect("history delete must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };
        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let request = server.next_frame().await;
        assert_eq!(request["type"], "history_delete_command");
        assert_eq!(request["requestId"], "desktop-history-delete");
        server
            .send(&json!({
                "type": "history_delete_result",
                "requestId": "desktop-history-delete",
                "result": {
                    "outcome": "partial_failure",
                    "deleted": {"requestLedger": 4, "diagnostics": 0, "capture": 2},
                    "failures": [{
                        "authority": "diagnostics",
                        "code": "storage_failure",
                        "deleted": 0
                    }],
                    "credentialCanary": "must-not-reach-renderer"
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("history delete must complete within the timeout")
            .expect("history delete task must not panic");
        let HistoryCommandResultWire::Delete(result) = result else {
            panic!("history delete must return a deletion result");
        };
        assert_eq!(result.outcome, "partial_failure");
        assert_eq!(result.failures.as_ref().map(Vec::len), Some(1));
        let projected = serde_json::to_value(result).expect("result must serialize");
        assert!(projected.get("credentialCanary").is_none());
    }

    #[tokio::test]
    async fn auto_start_command_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_auto_start_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                AutoStartAction::Status,
            )
            .await
            .expect("auto-start status must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        assert_eq!(
            hello.get("contractVersion").and_then(Value::as_u64),
            Some(CONTROL_PLANE_VERSION)
        );
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("application_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-auto-start-status")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("auto_start")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("action"))
                .and_then(Value::as_str),
            Some("status")
        );
        server
            .send(&json!({
                "type": "application_command_result",
                "requestId": "desktop-auto-start-status",
                "result": {
                    "command": "auto_start",
                    "outcome": "ok",
                    "autoStart": {"enabled": true},
                    "snapshot": {
                        "sequence": 2,
                        "modelDataPlane": "running",
                        "provider": "unconfigured"
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("auto-start status must complete within the timeout")
            .expect("auto-start status task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.enabled, Some(true));
    }

    #[tokio::test]
    async fn client_token_command_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_client_token_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                ClientTokenCommand::Rotate {
                    protocol_id: "anthropic-messages".to_owned(),
                    expected_revision: 2,
                    scope: Some(ClientTokenScopeWire {
                        scope_type: "project".to_owned(),
                        project_dir: Some("C:\\picked\\path".to_owned()),
                    }),
                    token: Some("canary-native-rotate-token".to_owned()),
                },
            )
            .await
            .expect("client token rotate must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        assert_eq!(
            hello.get("contractVersion").and_then(Value::as_u64),
            Some(CONTROL_PLANE_VERSION)
        );
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("client_token_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-client-tokens-rotate")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("rotate")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("protocolId"))
                .and_then(Value::as_str),
            Some("anthropic-messages")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("expectedRevision"))
                .and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("scope"))
                .and_then(|raw| raw.get("type"))
                .and_then(Value::as_str),
            Some("project")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("scope"))
                .and_then(|raw| raw.get("projectDir"))
                .and_then(Value::as_str),
            Some("C:\\picked\\path")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("token"))
                .and_then(Value::as_str),
            Some("canary-native-rotate-token")
        );
        server
            .send(&json!({
                "type": "client_token_command_result",
                "requestId": "desktop-client-tokens-rotate",
                "result": {
                    "outcome": "ok",
                    "revision": 3,
                    "scopes": [{
                        "type": "global",
                        "maskedToken": "canary-n…oken"
                    }]
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("rotate must complete within the timeout")
            .expect("rotate task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.revision, 3);
        let scopes = result
            .scopes
            .expect("rotate result must carry masked scopes");
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].scope_type, "global");
        assert_eq!(scopes[0].masked_token, "canary-n…oken");
    }

    #[tokio::test]
    async fn catalog_command_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_catalog_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                CatalogCommand::RefreshManual,
            )
            .await
            .expect("catalog refresh must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        assert_eq!(
            hello.get("contractVersion").and_then(Value::as_u64),
            Some(CONTROL_PLANE_VERSION)
        );
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("catalog_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-catalog-refresh-manual")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("refresh")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("mode"))
                .and_then(Value::as_str),
            Some("manual")
        );
        server
            .send(&json!({
                "type": "catalog_command_result",
                "requestId": "desktop-catalog-refresh-manual",
                "result": {
                    "outcome": "ok",
                    "snapshot": {
                        "version": 4,
                        "modelsJsonValid": true,
                        "refreshedAt": 1700000000000_u64,
                        "providers": [{
                            "providerId": "dynamic-a",
                            "name": "dynamic-a",
                            "dynamic": true,
                            "state": "succeeded",
                            "models": [{"id": "m", "dynamic": true, "availability": "available"}]
                        }],
                        "refreshErrors": []
                    },
                    "refresh": {
                        "trigger": "manual",
                        "startedAt": 1,
                        "finishedAt": 2,
                        "providers": [{"providerId": "dynamic-a", "outcome": "succeeded"}]
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("catalog refresh must complete within the timeout")
            .expect("catalog refresh task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.snapshot.version, 4);
        assert!(result.snapshot.models_json_valid);
        assert_eq!(result.snapshot.providers.len(), 1);
        assert_eq!(result.snapshot.refresh_errors.len(), 0);
        assert!(result.refresh.is_some());
    }

    #[tokio::test]
    async fn diagnostics_warnings_query_decodes_only_allowlisted_safe_fields() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_diagnostics_warnings_session(&pipe_name, "desktop-test-capability".to_owned())
                .await
                .expect("diagnostics warnings must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("get_diagnostics")
        );
        assert_eq!(
            request
                .get("query")
                .and_then(|raw| raw.get("minimumLevel"))
                .and_then(Value::as_str),
            Some("warning")
        );
        // A record with a raw credential in its details must still decode to
        // the allowlisted safe fields only: details/errors/fingerprints are
        // never forwarded to the renderer.
        server
            .send(&json!({
                "type": "diagnostics_result",
                "requestId": "desktop-diagnostics-warnings",
                "result": {
                    "records": [{
                        "id": 7,
                        "level": "warning",
                        "time": 1700000000000_u64,
                        "text": "Anthropic Messages has no active client token",
                        "details": {"raw": "canary-native-secret-999"},
                        "fingerprint": "fp:deadbeef"
                    }],
                    "hasMore": false
                }
            }))
            .await;

        let warnings = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("diagnostics query must complete within the timeout")
            .expect("diagnostics task must not panic");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].id, 7);
        assert_eq!(warnings[0].level, "warning");
        assert_eq!(
            warnings[0].text,
            "Anthropic Messages has no active client token"
        );
        let serialized = serde_json::to_value(&warnings).expect("serialize warnings");
        assert_eq!(
            serialized[0],
            json!({
                "id": 7,
                "level": "warning",
                "time": 1700000000000_u64,
                "text": "Anthropic Messages has no active client token"
            })
        );
        assert!(!serialized.to_string().contains("canary-native-secret-999"));
        assert!(!serialized.to_string().contains("fp:deadbeef"));
    }

    #[test]
    fn owner_identity_is_allowlisted_through_status_snapshots() {
        let raw = json!({
            "sequence": 5,
            "modelDataPlane": "running",
            "provider": "configured",
            "ownership": {
                "owner": {
                    "kind": "cli",
                    "pid": 4242,
                    "startedAt": "2026-08-15T12:00:00.000Z"
                }
            },
            "capability": "must-not-leave-the-native-shell"
        });

        let status = decode_status_snapshot(&raw).expect("decode ownership status");

        assert_eq!(
            serde_json::to_value(status).expect("serialize ownership status"),
            json!({
                "sequence": 5,
                "modelDataPlane": "running",
                "provider": "configured",
                "ownership": {
                    "owner": {
                        "kind": "cli",
                        "pid": 4242,
                        "startedAt": "2026-08-15T12:00:00.000Z"
                    }
                }
            })
        );
        // Unknown owner kinds and invalid identities never reach the shell.
        assert!(decode_status_snapshot(&json!({
            "sequence": 6,
            "modelDataPlane": "running",
            "provider": "configured",
            "ownership": {
                "owner": {"kind": "unknown", "pid": 1, "startedAt": "2026-08-15T12:00:00.000Z"}
            }
        }))
        .is_none());
    }

    #[test]
    fn failed_status_is_allowlisted_and_requires_the_configured_port() {
        let raw = json!({
            "sequence": 4,
            "modelDataPlane": "failed",
            "provider": "unconfigured",
            "dataPlane": {
                "configuredOrigin": "http://127.0.0.1:3000",
                "configuredPort": 3000,
                "failure": {
                    "code": "port_in_use",
                    "message": "raw native secret"
                },
                "secret": "ignored"
            }
        });

        let status = decode_status_snapshot(&raw).expect("decode failed status");

        assert_eq!(
            serde_json::to_value(status).expect("serialize failed status"),
            json!({
                "sequence": 4,
                "modelDataPlane": "failed",
                "provider": "unconfigured",
                "dataPlane": {
                    "configuredOrigin": "http://127.0.0.1:3000",
                    "configuredPort": 3000,
                    "failure": {
                        "code": "port_in_use",
                        "message": "The configured port is already in use. Stop the other application or choose a different port."
                    }
                }
            })
        );
        assert!(decode_status_snapshot(&json!({
            "sequence": 4,
            "modelDataPlane": "running",
            "provider": "unconfigured",
            "dataPlane": {
                "configuredOrigin": "http://127.0.0.1:3001",
                "configuredPort": 3000
            }
        }))
        .is_none());
    }

    #[tokio::test]
    async fn status_subscription_skips_diagnostics_typed_events_without_tearing_down() {
        // Ticket 07 adds typed diagnostics events to the Control Plane wire.
        // The status-only bridge subscription must never consume them and
        // must keep serving status events that follow them.
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");

        let session_task = tokio::spawn(async move {
            let session = connect_session(&pipe_name, "desktop-test-capability".to_owned(), false)
                .await
                .expect("session must negotiate a compatible hello");
            let ConnectResult::Connected(mut session) = session else {
                panic!("reconnect must produce a connected session");
            };
            session.next_status().await
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let status = server.next_frame().await;
        assert_eq!(
            status.get("type").and_then(Value::as_str),
            Some("get_status")
        );
        server
            .send(&json!({
                "type": "status_result",
                "requestId": "desktop-status",
                "snapshot": {
                    "sequence": 1,
                    "modelDataPlane": "running",
                    "provider": "unconfigured"
                }
            }))
            .await;
        let subscribe = server.next_frame().await;
        assert_eq!(
            subscribe.get("type").and_then(Value::as_str),
            Some("subscribe")
        );
        server
            .send(&json!({"type": "subscribed", "requestId": "desktop-subscribe"}))
            .await;

        // A diagnostics-typed event on the status subscription must be
        // skipped, not treated as a protocol error.
        server
            .send(&json!({
                "type": "event",
                "event": {
                    "type": "diagnostic",
                    "record": {
                        "id": "diag-1",
                        "kind": "invocation",
                        "createdAt": "2026-08-15T00:00:00.000Z",
                        "data": {"raw": "redacted"}
                    }
                }
            }))
            .await;
        // The following status event must still surface.
        server
            .send(&json!({
                "type": "event",
                "event": {
                    "type": "status_changed",
                    "sequence": 2,
                    "snapshot": {
                        "sequence": 2,
                        "modelDataPlane": "running",
                        "provider": "unconfigured"
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("status must surface within the timeout")
            .expect("status session task must not panic")
            .expect("status event after a skipped diagnostics event must not be a protocol error");
        assert_eq!(
            result.sequence, 2,
            "status event after a skipped diagnostics event must surface"
        );
    }

    #[tokio::test]
    async fn credential_command_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_credential_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                CredentialCommand::Login {
                    provider_id: "anthropic".to_owned(),
                    expected_revision: 1,
                    value: "sk-native-canary-1".to_owned(),
                    overwrite: true,
                },
            )
            .await
            .expect("credential login must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("credential_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-credentials-login")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("login")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("providerId"))
                .and_then(Value::as_str),
            Some("anthropic")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("expectedRevision"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("overwrite"))
                .and_then(Value::as_bool),
            Some(true)
        );
        server
            .send(&json!({
                "type": "credential_command_result",
                "requestId": "desktop-credentials-login",
                "result": {
                    "outcome": "ok",
                    "revision": 2,
                    "changed": true,
                    "state": {
                        "revision": 2,
                        "path": "C:\\auth.json",
                        "present": true,
                        "valid": true,
                        "providers": [{
                            "providerId": "anthropic",
                            "stored": true,
                            "storedType": "api_key",
                            "environment": false,
                            "modelsJson": false,
                            "commandDerived": false,
                            "expired": false,
                            "unavailable": false,
                            "effectiveSource": "stored"
                        }]
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("login must complete within the timeout")
            .expect("login task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.revision, 2);
        assert_eq!(result.changed, Some(true));
        assert_eq!(result.state.providers[0].effective_source, "stored");
    }

    #[tokio::test]
    async fn credential_import_preview_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_credential_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                CredentialCommand::ImportPreview {
                    expected_revision: 0,
                    content: "{\"provider-a\":{\"type\":\"api_key\",\"key\":\"sk-x\"}}".to_owned(),
                },
            )
            .await
            .expect("import preview must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("credential_command")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("import_preview")
        );
        server
            .send(&json!({
                "type": "credential_command_result",
                "requestId": "desktop-credentials-import-preview",
                "result": {
                    "outcome": "ok",
                    "revision": 0,
                    "importId": "import-native-1",
                    "previewEntries": [{
                        "providerId": "provider-a",
                        "type": "api_key",
                        "wouldOverwrite": true
                    }],
                    "state": {
                        "revision": 0,
                        "path": "C:\\auth.json",
                        "present": false,
                        "valid": false,
                        "providers": []
                    }
                }
            }))
            .await;
        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("preview must complete within the timeout")
            .expect("preview task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(
            result
                .preview_entries
                .as_ref()
                .map(|entries| entries[0].provider_id.as_str()),
            Some("provider-a")
        );
    }

    #[tokio::test]
    async fn unavailable_credential_dto_crosses_the_versioned_wire() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_credential_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                CredentialCommand::Query,
            )
            .await
            .expect("credential query must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let _request = server.next_frame().await;
        // The unavailable DTO carries a minimal value-free state with no
        // path: the thin bridge must accept and project it.
        server
            .send(&json!({
                "type": "credential_command_result",
                "requestId": "desktop-credentials-query",
                "result": {
                    "outcome": "unavailable",
                    "revision": 0,
                    "state": {
                        "revision": 0,
                        "path": "",
                        "present": false,
                        "valid": false,
                        "providers": []
                    },
                    "error": "Credential Authority is unavailable"
                }
            }))
            .await;
        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("query must complete within the timeout")
            .expect("query task must not panic");
        assert_eq!(result.outcome, "unavailable");
        assert!(result.state.path.is_empty());
        assert!(result.state.providers.is_empty());
    }

    #[tokio::test]
    async fn empty_credential_import_preview_crosses_the_versioned_wire() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_credential_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                CredentialCommand::ImportPreview {
                    expected_revision: 0,
                    content: "{}".to_owned(),
                },
            )
            .await
            .expect("import preview must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let _request = server.next_frame().await;
        server
            .send(&json!({
                "type": "credential_command_result",
                "requestId": "desktop-credentials-import-preview",
                "result": {
                    "outcome": "ok",
                    "revision": 0,
                    "importId": "import-empty-1",
                    "previewEntries": [],
                    "state": {
                        "revision": 0,
                        "path": "C:' + BS + BS + 'auth.json",
                        "present": false,
                        "valid": false,
                        "providers": []
                    }
                }
            }))
            .await;
        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("preview must complete within the timeout")
            .expect("preview task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.preview_entries.as_ref().map(Vec::len), Some(0));
    }

    #[tokio::test]
    async fn auth_query_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_auth_query_session(&pipe_name, "desktop-test-capability".to_owned())
                .await
                .expect("auth query must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        assert_eq!(
            hello.get("contractVersion").and_then(Value::as_u64),
            Some(CONTROL_PLANE_VERSION)
        );
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("auth_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-auth-query")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("query")
        );
        server
            .send(&json!({
                "type": "auth_command_result",
                "requestId": "desktop-auth-query",
                "result": {
                    "outcome": "ok",
                    "state": {
                        "revision": 1,
                        "path": "C:\\auth.json",
                        "present": false,
                        "valid": false,
                        "providers": []
                    },
                    "options": {
                        "providers": [{
                            "providerId": "anthropic",
                            "name": "Anthropic",
                            "account": true,
                            "subscription": true,
                            "apiKey": true,
                            "status": {
                                "providerId": "anthropic",
                                "stored": false,
                                "environment": false,
                                "modelsJson": false,
                                "commandDerived": false,
                                "expired": false,
                                "unavailable": false,
                                "effectiveSource": "none"
                            }
                        }]
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("auth query must complete within the timeout")
            .expect("auth query task must not panic");
        assert_eq!(result.outcome, "ok");
        let options = result.options.expect("query result must carry options");
        assert_eq!(options["providers"][0]["providerId"], json!("anthropic"));
        assert_eq!(
            options["providers"][0]["subscription"],
            json!(true),
            "only Provider metadata may mark a flow as a true subscription"
        );
    }

    #[tokio::test]
    async fn auth_login_session_forwards_typed_events_and_routes_responses() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let forwarded_events = events.clone();
        let events_for_forward = events.clone();
        let session_task = tokio::spawn(async move {
            let mut session = execute_auth_login_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                AuthCommand::Login {
                    provider_id: "anthropic".to_owned(),
                    auth_type: "oauth".to_owned(),
                    request_id: "desktop-auth-login-1".to_owned(),
                },
                move |event| events_for_forward.lock().unwrap().push(event),
            )
            .await
            .expect("auth login must negotiate");
            // Wait until both typed events are forwarded (the prompt event
            // sets the flow's pending prompt slot) before answering.
            timeout(Duration::from_secs(5), async {
                loop {
                    let ready = {
                        let captured = forwarded_events.lock().unwrap();
                        captured.len() == 2
                    };
                    if ready {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("typed events must be forwarded before the response");
            session
                .session
                .respond(&AuthInteractionResponse::PromptResponse {
                    prompt_id: "p1".to_owned(),
                    value: "FAKE-USER-CODE".to_owned(),
                })
                .await
                .expect("response must route into the session");
            session
                .result
                .await
                .expect("login flow must resolve")
                .expect("login flow must succeed")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("auth_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-auth-login-1")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("login")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("providerId"))
                .and_then(Value::as_str),
            Some("anthropic")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("authType"))
                .and_then(Value::as_str),
            Some("oauth")
        );

        // Two typed events arrive; both must be forwarded in order before
        // the response routes back.
        server
            .send(&json!({
                "type": "auth_interaction_event",
                "requestId": "desktop-auth-login-1",
                "event": {"type": "auth_url", "url": "https://example.com/authorize"}
            }))
            .await;
        server
            .send(&json!({
                "type": "auth_interaction_event",
                "requestId": "desktop-auth-login-1",
                "event": {"type": "prompt", "promptId": "p1", "kind": "text", "message": "Enter the code"}
            }))
            .await;
        let forwarded = timeout(Duration::from_secs(5), async {
            loop {
                let captured = {
                    let captured = events.lock().unwrap();
                    (captured.len() == 2).then(|| captured.clone())
                };
                if let Some(captured) = captured {
                    break captured;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("typed events must be forwarded");
        assert_eq!(forwarded[0]["type"], json!("auth_url"));
        assert_eq!(forwarded[1]["promptId"], json!("p1"));

        // The typed response must cross the pipe with the Rust-stamped
        // request id.
        let response = server.next_frame().await;
        assert_eq!(
            response.get("type").and_then(Value::as_str),
            Some("auth_interaction_response")
        );
        assert_eq!(
            response.get("requestId").and_then(Value::as_str),
            Some("desktop-auth-login-1")
        );
        assert_eq!(
            response
                .get("response")
                .and_then(|raw| raw.get("type"))
                .and_then(Value::as_str),
            Some("prompt_response")
        );
        assert_eq!(
            response
                .get("response")
                .and_then(|raw| raw.get("promptId"))
                .and_then(Value::as_str),
            Some("p1")
        );
        assert_eq!(
            response
                .get("response")
                .and_then(|raw| raw.get("value"))
                .and_then(Value::as_str),
            Some("FAKE-USER-CODE")
        );

        server
            .send(&json!({
                "type": "auth_command_result",
                "requestId": "desktop-auth-login-1",
                "result": {
                    "outcome": "ok",
                    "state": {
                        "revision": 2,
                        "path": "C:\\auth.json",
                        "present": true,
                        "valid": true,
                        "providers": [{
                            "providerId": "anthropic",
                            "stored": true,
                            "storedType": "oauth",
                            "environment": false,
                            "modelsJson": false,
                            "commandDerived": false,
                            "expired": false,
                            "unavailable": false,
                            "effectiveSource": "stored"
                        }]
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("login must complete within the timeout")
            .expect("login task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(
            result.state.providers[0].stored_type.as_deref(),
            Some("oauth")
        );
        assert!(
            result.options.is_none(),
            "a login result never carries options"
        );
    }

    #[tokio::test]
    async fn auth_login_session_rejects_malformed_or_foreign_frames_as_protocol_errors() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            let session = execute_auth_login_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                AuthCommand::Login {
                    provider_id: "anthropic".to_owned(),
                    auth_type: "oauth".to_owned(),
                    request_id: "desktop-auth-login-1".to_owned(),
                },
                |_| {},
            )
            .await
            .expect("auth login must negotiate");
            session
                .result
                .await
                .expect("login flow must resolve")
                .expect_err("a malformed event must fail the flow")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let _request = server.next_frame().await;
        // A secret-bearing event outside the allowlist is a protocol
        // error: it must never be forwarded to the renderer.
        server
            .send(&json!({
                "type": "auth_interaction_event",
                "requestId": "desktop-auth-login-1",
                "event": {"type": "evil", "secret": "canary-native-secret"}
            }))
            .await;
        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("login must fail within the timeout")
            .expect("login task must not panic");
        assert_eq!(result, ConnectionFailure::ProtocolError);
    }

    #[tokio::test]
    async fn auth_login_session_rejects_foreign_frames_as_protocol_errors() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            let session = execute_auth_login_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                AuthCommand::Login {
                    provider_id: "anthropic".to_owned(),
                    auth_type: "oauth".to_owned(),
                    request_id: "desktop-auth-login-1".to_owned(),
                },
                |_| {},
            )
            .await
            .expect("auth login must negotiate");
            session
                .result
                .await
                .expect("login flow must resolve")
                .expect_err("a foreign frame must fail the flow")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let _hello = server.next_frame().await;
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;
        let _request = server.next_frame().await;
        // A status frame on the auth connection is never a valid event or
        // result: strict projection rejects it.
        server
            .send(&json!({
                "type": "status_result",
                "requestId": "desktop-status",
                "snapshot": {
                    "sequence": 1,
                    "modelDataPlane": "running",
                    "provider": "unconfigured"
                }
            }))
            .await;
        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("login must fail within the timeout")
            .expect("login task must not panic");
        assert_eq!(result, ConnectionFailure::ProtocolError);
    }

    #[test]
    fn auth_command_result_rejects_value_free_violations() {
        let query = AuthCommand::Query;
        let login = AuthCommand::Login {
            provider_id: "anthropic".to_owned(),
            auth_type: "oauth".to_owned(),
            request_id: "desktop-auth-login-1".to_owned(),
        };
        let state = json!({
            "revision": 0,
            "path": "C:\\auth.json",
            "present": false,
            "valid": false,
            "providers": []
        });
        let valid_options = json!({"providers": []});
        let frame = |result: Value| {
            json!({
                "type": "auth_command_result",
                "requestId": "desktop-auth-query",
                "result": result
            })
        };
        // An ok query without options never decodes.
        assert!(decode_auth_command_result(
            &frame(json!({
                "outcome": "ok",
                "state": state.clone()
            })),
            &query
        )
        .is_err());
        // An ok query never carries an error.
        assert!(decode_auth_command_result(
            &frame(json!({
                "outcome": "ok",
                "state": state.clone(),
                "options": valid_options.clone(),
                "error": "must not ride on ok"
            })),
            &query
        )
        .is_err());
        // Non-ok outcomes require a value-free error.
        assert!(decode_auth_command_result(
            &frame(json!({
                "outcome": "failed",
                "state": state.clone(),
                "error": ""
            })),
            &query
        )
        .is_err());
        // Non-ok outcomes never carry options.
        assert!(decode_auth_command_result(
            &frame(json!({
                "outcome": "failed",
                "state": state.clone(),
                "error": "Sign-in did not complete.",
                "options": valid_options
            })),
            &query
        )
        .is_err());
        // A login result never carries options.
        let login_frame = |result: Value| {
            json!({
                "type": "auth_command_result",
                "requestId": "desktop-auth-login-1",
                "result": result
            })
        };
        assert!(decode_auth_command_result(
            &login_frame(json!({
                "outcome": "ok",
                "state": state.clone(),
                "options": {"providers": []}
            })),
            &login
        )
        .is_err());
        // The unavailable DTO may carry the minimal empty-path state.
        let unavailable = decode_auth_command_result(
            &frame(json!({
                "outcome": "unavailable",
                "state": {
                    "revision": 0,
                    "path": "",
                    "present": false,
                    "valid": false,
                    "providers": []
                },
                "error": "Credential Authority is unavailable"
            })),
            &query,
        )
        .expect("the unavailable DTO must decode with its empty path");
        assert_eq!(unavailable.outcome, "unavailable");
        // A non-unavailable outcome with an empty path never decodes.
        assert!(decode_auth_command_result(
            &frame(json!({
                "outcome": "ok",
                "state": {
                    "revision": 0,
                    "path": "",
                    "present": false,
                    "valid": false,
                    "providers": []
                },
                "options": {"providers": []}
            })),
            &query
        )
        .is_err());
        // A valid ok query decodes with its options.
        let decoded = decode_auth_command_result(
            &frame(json!({
                "outcome": "ok",
                "state": state.clone(),
                "options": {"providers": []}
            })),
            &query,
        )
        .expect("valid ok query must decode");
        assert_eq!(decoded.outcome, "ok");
        assert!(decoded.options.is_some());
    }
}

#[cfg(test)]
mod ticket17_directory_scope_tests {
    use super::*;

    #[test]
    fn create_command_serializes_scope_and_invalid_directory_reason_decodes() {
        let command = ClientTokenCommand::Create {
            protocol_id: "anthropic-messages".to_owned(),
            scope: ClientTokenScopeWire {
                scope_type: "project".to_owned(),
                project_dir: Some("C:\\picked\\path".to_owned()),
            },
            token: None,
        };
        assert_eq!(command.request_id(), "desktop-client-tokens-create");
        // Wire serialization mirrors the backend contract.
        let serialized = serde_json::to_value(scope_json(&ClientTokenScopeWire {
            scope_type: "project".to_owned(),
            project_dir: Some("C:\\picked\\path".to_owned()),
        }))
        .expect("scope must serialize");
        assert_eq!(serialized["type"], "project");
        assert_eq!(serialized["projectDir"], "C:\\picked\\path");

        // A value-free invalid_directory result decodes with its reason.
        let decoded = decode_client_token_command_result(
            &json!({
                "type": "client_token_command_result",
                "requestId": "desktop-client-tokens-create",
                "result": {
                    "outcome": "invalid_directory",
                    "revision": 4,
                    "reason": "not_found",
                    "error": "Selected directory is not usable as a client token scope"
                }
            }),
            &command,
        )
        .expect("invalid_directory result must decode");
        assert_eq!(decoded.outcome, "invalid_directory");
        assert_eq!(decoded.reason.as_deref(), Some("not_found"));
        assert_eq!(
            decoded.error.as_deref(),
            Some("Selected directory is not usable as a client token scope")
        );

        // A reason that is not part of the taxonomy never decodes.
        let malformed = decode_client_token_command_result(
            &json!({
                "type": "client_token_command_result",
                "requestId": "desktop-client-tokens-create",
                "result": {
                    "outcome": "invalid_directory",
                    "revision": 4,
                    "reason": "C:\\raw\\path",
                    "error": "Selected directory is not usable as a client token scope"
                }
            }),
            &command,
        );
        assert!(malformed.is_err());
        // An already_exists result decodes (duplicate scope).
        let duplicate = decode_client_token_command_result(
            &json!({
                "type": "client_token_command_result",
                "requestId": "desktop-client-tokens-create",
                "result": {
                    "outcome": "already_exists",
                    "revision": 4,
                    "error": "Client token scope already has a token"
                }
            }),
            &command,
        )
        .expect("already_exists result must decode");
        assert_eq!(duplicate.outcome, "already_exists");
    }

    #[test]
    fn request_identities_reject_effective_session_records_and_unknown_keys() {
        let base = json!({
            "type": "request_identities_result",
            "requestId": "desktop-request-identities",
            "result": { "records": [
                {
                    "id": 2,
                    "time": 1700000000000_i64,
                    "protocolId": "anthropic-messages",
                    "clientSessionId": "11111111-1111-4111-8111-111111111111",
                    "projectDir": "C:\\canonical\\project"
                },
                {
                    "id": 1,
                    "time": 1699999999999_i64,
                    "protocolId": "openai-responses"
                }
            ] }
        });
        let records = decode_request_identities(&base).expect("valid records must decode");
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0].client_session_id.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(
            records[0].project_dir.as_deref(),
            Some("C:\\canonical\\project")
        );
        assert_eq!(records[1].client_session_id, None);

        // The internal effective session identity must never reach the
        // renderer: a record carrying it is rejected at the bridge.
        let leaking = json!({
            "type": "request_identities_result",
            "requestId": "desktop-request-identities",
            "result": { "records": [
                {
                    "id": 3,
                    "time": 1700000000000_i64,
                    "protocolId": "anthropic-messages",
                    "effectiveSessionId": "22222222-2222-4222-8222-222222222222"
                }
            ] }
        });
        assert!(decode_request_identities(&leaking).is_err());
        // Unknown keys and non-UUID client session ids are rejected too.
        let unknown = json!({
            "type": "request_identities_result",
            "requestId": "desktop-request-identities",
            "result": { "records": [
                { "id": 4, "time": 1, "protocolId": "x", "sessionId": "abc" }
            ] }
        });
        assert!(decode_request_identities(&unknown).is_err());
        let not_uuid = json!({
            "type": "request_identities_result",
            "requestId": "desktop-request-identities",
            "result": { "records": [
                { "id": 5, "time": 1, "protocolId": "x", "clientSessionId": "not-a-uuid" }
            ] }
        });
        assert!(decode_request_identities(&not_uuid).is_err());
    }

    fn ledger_record_base() -> Value {
        json!({
            "id": 1,
            "requestId": "10000000-0000-4000-8000-000000000001",
            "protocolId": "anthropic-messages",
            "phase": "terminal-preparation",
            "outcome": "success",
            "acceptedAt": 1700000000000_i64,
            "executionStartedAt": 1700000001000_i64,
            "terminalAt": 1700000003000_i64,
            "completedAt": 1700000003010_i64,
            "clientHttpStatus": 200,
            "externalAlias": "alpha",
            "providerId": "commandcode-private",
            "realModelId": "claude-fixture",
            "clientSessionId": "20000000-0000-4000-8000-000000000031",
            "effectiveSessionId": "30000000-0000-4000-8000-000000000032",
            "projectDir": "C:\\canonical\\project",
            "facts": {
                "piStopReason": "stop"
            },
            "terminalUsage": {
                "api": "commandcode-private",
                "input": 5,
                "cacheRead": 3,
                "cacheWrite": 2,
                "output": 100,
                "completeness": "complete"
            }
        })
    }

    #[test]
    fn request_ledger_record_decodes_a_full_allowlisted_record() {
        let record = decode_request_ledger_record(&ledger_record_base())
            .expect("valid ledger record must decode");
        assert_eq!(record.id, 1);
        assert_eq!(record.request_id, "10000000-0000-4000-8000-000000000001");
        assert_eq!(record.protocol_id, "anthropic-messages");
        assert_eq!(record.phase, "terminal-preparation");
        assert_eq!(record.outcome, "success");
        assert_eq!(record.client_http_status, Some(200));
        assert_eq!(
            record.client_session_id.as_deref(),
            Some("20000000-0000-4000-8000-000000000031")
        );
        assert_eq!(
            record.effective_session_id.as_deref(),
            Some("30000000-0000-4000-8000-000000000032")
        );
        assert_eq!(record.external_alias.as_deref(), Some("alpha"));
        // The facts object rides opaque; its sub-keys are the renderer's
        // strict decode boundary.
        assert!(record.facts.is_some());
        // The canonical terminal-usage snapshot rides opaque too; the
        // native shell never derives usage semantics.
        assert!(record.terminal_usage.is_some());
    }

    #[test]
    fn request_ledger_record_rejects_unknown_keys_and_invalid_values() {
        let mut with_unknown = ledger_record_base();
        with_unknown["invented"] = json!(true);
        assert!(decode_request_ledger_record(&with_unknown).is_none());

        let mut bad_request_id = ledger_record_base();
        bad_request_id["requestId"] = json!("not-a-uuid");
        assert!(decode_request_ledger_record(&bad_request_id).is_none());

        let mut bad_phase = ledger_record_base();
        bad_phase["phase"] = json!("streaming");
        assert!(decode_request_ledger_record(&bad_phase).is_none());

        let mut bad_outcome = ledger_record_base();
        bad_outcome["outcome"] = json!("cancelled");
        assert!(decode_request_ledger_record(&bad_outcome).is_none());

        let mut bad_status = ledger_record_base();
        bad_status["clientHttpStatus"] = json!(42);
        assert!(decode_request_ledger_record(&bad_status).is_none());

        let mut bad_session = ledger_record_base();
        bad_session["clientSessionId"] = json!("not-a-uuid");
        assert!(decode_request_ledger_record(&bad_session).is_none());

        let mut bad_effective = ledger_record_base();
        bad_effective["effectiveSessionId"] = json!("also-not-a-uuid");
        assert!(decode_request_ledger_record(&bad_effective).is_none());

        let mut missing_id = ledger_record_base();
        missing_id.as_object_mut().unwrap().remove("id");
        assert!(decode_request_ledger_record(&missing_id).is_none());

        let mut long_protocol = ledger_record_base();
        long_protocol["protocolId"] = json!("x".repeat(129));
        assert!(decode_request_ledger_record(&long_protocol).is_none());

        let mut scalar_facts = ledger_record_base();
        scalar_facts["facts"] = json!("not-an-object");
        assert!(decode_request_ledger_record(&scalar_facts).is_none());

        let mut scalar_usage = ledger_record_base();
        scalar_usage["terminalUsage"] = json!("not-an-object");
        assert!(decode_request_ledger_record(&scalar_usage).is_none());
    }

    #[test]
    fn request_ledger_result_decodes_clean_results_and_rejects_bad_frames() {
        let result = json!({
            "type": "request_ledger_result",
            "requestId": "desktop-request-ledger",
            "result": {
                "records": [ledger_record_base()],
                "hasMore": false
            }
        });
        let decoded = decode_request_ledger_result(&result).expect("valid result must decode");
        assert_eq!(decoded.records.len(), 1);
        assert!(!decoded.has_more);

        // Wrong type/requestId headers are protocol errors.
        let wrong_type = json!({
            "type": "request_identities_result",
            "requestId": "desktop-request-ledger",
            "result": { "records": [], "hasMore": false }
        });
        assert!(decode_request_ledger_result(&wrong_type).is_err());
        let wrong_id = json!({
            "type": "request_ledger_result",
            "requestId": "desktop-request-identities",
            "result": { "records": [], "hasMore": false }
        });
        assert!(decode_request_ledger_result(&wrong_id).is_err());
        // A malformed record inside the result fails the whole frame.
        let mut bad_record = ledger_record_base();
        bad_record["clientHttpStatus"] = json!(999);
        let with_bad_record = json!({
            "type": "request_ledger_result",
            "requestId": "desktop-request-ledger",
            "result": { "records": [bad_record], "hasMore": false }
        });
        assert!(decode_request_ledger_result(&with_bad_record).is_err());
        // Missing hasMore is a protocol error.
        let missing_has_more = json!({
            "type": "request_ledger_result",
            "requestId": "desktop-request-ledger",
            "result": { "records": [] }
        });
        assert!(decode_request_ledger_result(&missing_has_more).is_err());
    }

    #[test]
    fn analytics_result_decodes_clean_results_and_rejects_unknown_or_monetary_keys() {
        let totals = json!({});
        let summary = json!({
            "type": "analytics_result",
            "requestId": "desktop-analytics",
            "result": {
                "version": 1,
                "command": "summary",
                "totals": totals,
                "rows": [ { "dimension": "provider", "value": "anthropic", "summary": {} } ],
                "truncated": true,
                "omittedGroupCount": 3,
                "omittedGroupRequests": 12,
                "buckets": [ { "start": 1700000000000_u64, "end": 1700003600000_u64, "summary": {} } ]
            }
        });
        let decoded = decode_analytics_result(&summary).expect("valid summary must decode");
        assert_eq!(decoded.version, 1);
        assert_eq!(decoded.command, "summary");
        assert!(decoded.totals.is_some());
        assert_eq!(decoded.rows.as_ref().map(Vec::len), Some(1));
        assert_eq!(decoded.truncated, Some(true));
        assert_eq!(decoded.omitted_group_count, Some(3));
        assert_eq!(decoded.omitted_group_requests, Some(12));
        assert_eq!(decoded.buckets.as_ref().map(Vec::len), Some(1));
        assert!(decoded.providers.is_none());

        let mut options = json!({
            "type": "analytics_result",
            "requestId": "desktop-analytics",
            "result": {
                "version": 1,
                "command": "options",
                "providers": ["anthropic"],
                "models": ["claude-x"],
                "protocols": [],
                "projects": [],
                "outcomes": ["success"]
            }
        });
        let decoded = decode_analytics_result(&options).expect("valid options must decode");
        assert_eq!(decoded.command, "options");
        assert_eq!(
            decoded.providers.as_deref(),
            Some(&["anthropic".to_owned()][..])
        );
        assert_eq!(
            decoded.models.as_deref(),
            Some(&["claude-x".to_owned()][..])
        );
        assert!(decoded.totals.is_none());

        // Unknown keys anywhere — including any monetary field — reject.
        for key in ["cost", "price", "billing", "amount"] {
            let mut hostile = summary.clone();
            hostile["result"][key] = json!(5);
            assert!(
                decode_analytics_result(&hostile).is_err(),
                "frame with {key} must be rejected",
            );
        }
        // Wrong type/requestId/version/command reject.
        let mut wrong_version = summary.clone();
        wrong_version["result"]["version"] = json!(2);
        assert!(decode_analytics_result(&wrong_version).is_err());
        let mut wrong_command = summary.clone();
        wrong_command["result"]["command"] = json!("rollup");
        assert!(decode_analytics_result(&wrong_command).is_err());
        let mut wrong_type = summary.clone();
        wrong_type["type"] = json!("request_ledger_result");
        assert!(decode_analytics_result(&wrong_type).is_err());
        let mut wrong_id = summary.clone();
        wrong_id["requestId"] = json!("desktop-request-ledger");
        assert!(decode_analytics_result(&wrong_id).is_err());

        // Malformed sub-shapes reject: missing totals, empty rows, missing
        // options dimensions, oversized options arrays, empty strings.
        let mut no_totals = summary.clone();
        no_totals["result"]
            .as_object_mut()
            .unwrap()
            .remove("totals");
        assert!(decode_analytics_result(&no_totals).is_err());
        let mut empty_rows = summary.clone();
        empty_rows["result"]["rows"] = json!([]);
        assert!(decode_analytics_result(&empty_rows).is_err());
        let mut missing_providers = options.clone();
        missing_providers["result"]
            .as_object_mut()
            .unwrap()
            .remove("providers");
        assert!(decode_analytics_result(&missing_providers).is_err());
        let many = (0..65).map(|i| json!(format!("p{i}"))).collect::<Vec<_>>();
        options["result"]["providers"] = json!(many);
        assert!(decode_analytics_result(&options).is_err());
        let empty_string = json!({
            "type": "analytics_result",
            "requestId": "desktop-analytics",
            "result": {
                "version": 1,
                "command": "options",
                "providers": [""],
                "models": [],
                "protocols": [],
                "projects": [],
                "outcomes": []
            }
        });
        assert!(decode_analytics_result(&empty_string).is_err());
    }
}

#[cfg(test)]
mod ticket14_alias_transport_tests {
    use super::*;
    use std::time::Duration;
    use tokio::{net::windows::named_pipe::ServerOptions, time::timeout};

    fn alias_result_state() -> Value {
        json!({
            "revision": 3,
            "path": "C:\\app\\data\\model-aliases.json",
            "present": true,
            "valid": true,
            "raw": "{\"aliases\":{}}",
            "defaultsVersion": 1,
            "catalogVersion": 4,
            "aliases": {
                "gpt-4o": { "provider": "anthropic", "model": "claude-3-5-sonnet" }
            },
            "effective": {
                "defaultsVersion": 1,
                "aliases": [{
                    "alias": "gpt-4o",
                    "target": {
                        "provider": "anthropic",
                        "model": "claude-3-5-sonnet"
                    },
                    "layer": "user"
                }],
                "errors": []
            }
        })
    }

    #[tokio::test]
    async fn alias_query_exchanges_the_versioned_wire_and_decodes_the_result() {
        let pipe_name = test_pipe_name();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let session_task = tokio::spawn(async move {
            execute_alias_command_session(
                &pipe_name,
                "desktop-test-capability".to_owned(),
                AliasCommand::Query,
            )
            .await
            .expect("alias query must negotiate and complete")
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestPipeServer { server };

        let hello = server.next_frame().await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
        assert_eq!(
            hello.get("contractVersion").and_then(Value::as_u64),
            Some(CONTROL_PLANE_VERSION)
        );
        server
            .send(&json!({
                "type": "hello_result",
                "requestId": "desktop-hello",
                "result": {
                    "type": "compatible",
                    "application": {"id": "luckytoken", "version": "native-test"},
                    "contractVersion": CONTROL_PLANE_VERSION
                }
            }))
            .await;

        let request = server.next_frame().await;
        assert_eq!(
            request.get("type").and_then(Value::as_str),
            Some("alias_command")
        );
        assert_eq!(
            request.get("requestId").and_then(Value::as_str),
            Some("desktop-aliases-query")
        );
        assert_eq!(
            request
                .get("command")
                .and_then(|raw| raw.get("command"))
                .and_then(Value::as_str),
            Some("query")
        );
        server
            .send(&json!({
                "type": "alias_command_result",
                "requestId": "desktop-aliases-query",
                "result": {
                    "outcome": "ok",
                    "state": alias_result_state()
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), session_task)
            .await
            .expect("alias query must complete within the timeout")
            .expect("alias query task must not panic");
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.state.revision, 3);
        assert!(result.state.present);
        assert!(result.state.valid);
        assert_eq!(result.state.defaults_version, 1);
        assert_eq!(result.state.catalog_version, 4);
        let effective = result
            .state
            .effective
            .expect("query result must carry the effective registry");
        assert_eq!(effective.aliases.len(), 1);
        assert_eq!(effective.aliases[0].alias, "gpt-4o");
        assert_eq!(effective.aliases[0].target.provider, "anthropic");
        assert_eq!(effective.aliases[0].layer, "user");
        assert!(result.error.is_none());
    }

    #[test]
    fn alias_write_serializes_revision_and_aliases_and_decodes_the_result() {
        let command = AliasCommand::Write {
            revision: 3,
            aliases: json!({
                "gpt-4o": { "provider": "anthropic", "model": "claude-3-5-sonnet" }
            }),
        };
        assert_eq!(command.request_id(), "desktop-aliases-write");
        let wire = command.wire();
        assert_eq!(wire["command"], "write");
        assert_eq!(wire["revision"], 3);
        assert_eq!(wire["aliases"]["gpt-4o"]["provider"], "anthropic");

        // A rejected proposal surfaces as a sanitized invalid outcome.
        let decoded = decode_alias_command_result(
            &json!({
                "type": "alias_command_result",
                "requestId": "desktop-aliases-write",
                "result": {
                    "outcome": "invalid",
                    "state": alias_result_state(),
                    "error": {
                        "kind": "validation",
                        "message": "1 rejected alias proposal",
                        "entries": [{
                            "alias": "…",
                            "code": "invalid",
                            "message": "alias must be a non-empty trimmed string"
                        }]
                    }
                }
            }),
            &command,
        )
        .expect("invalid write result must decode");
        assert_eq!(decoded.outcome, "invalid");
        let error = decoded.error.expect("invalid result must carry the error");
        assert_eq!(error.kind, "validation");
        let entries = error.entries.expect("validation error must carry entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].code, "invalid");
        assert!(decoded.state.aliases.is_some());

        // A conflict outcome (stale revision) decodes without an error.
        let conflict = decode_alias_command_result(
            &json!({
                "type": "alias_command_result",
                "requestId": "desktop-aliases-write",
                "result": {
                    "outcome": "conflict",
                    "state": alias_result_state()
                }
            }),
            &command,
        )
        .expect("conflict write result must decode");
        assert_eq!(conflict.outcome, "conflict");
    }

    #[test]
    fn alias_command_result_rejects_malformed_outcomes_shapes_and_request_ids() {
        let command = AliasCommand::Write {
            revision: 3,
            aliases: json!({"gpt-4o": "anthropic/claude-3-5-sonnet"}),
        };
        // An outcome outside the taxonomy never decodes.
        let unknown_outcome = decode_alias_command_result(
            &json!({
                "type": "alias_command_result",
                "requestId": "desktop-aliases-write",
                "result": {"outcome": "pending", "state": alias_result_state()}
            }),
            &command,
        );
        assert_eq!(unknown_outcome, Err(ConnectionFailure::ProtocolError));
        // A mismatched request id never decodes.
        let wrong_request = decode_alias_command_result(
            &json!({
                "type": "alias_command_result",
                "requestId": "desktop-aliases-query",
                "result": {"outcome": "ok", "state": alias_result_state()}
            }),
            &command,
        );
        assert_eq!(wrong_request, Err(ConnectionFailure::ProtocolError));
        // A missing state never decodes.
        let missing_state = decode_alias_command_result(
            &json!({
                "type": "alias_command_result",
                "requestId": "desktop-aliases-write",
                "result": {"outcome": "ok"}
            }),
            &command,
        );
        assert_eq!(missing_state, Err(ConnectionFailure::ProtocolError));
        // A state with a malformed shape (missing required field) never decodes.
        let malformed_state = decode_alias_command_result(
            &json!({
                "type": "alias_command_result",
                "requestId": "desktop-aliases-write",
                "result": {
                    "outcome": "ok",
                    "state": {"revision": 3, "path": "C:\\x", "present": true}
                }
            }),
            &command,
        );
        assert_eq!(malformed_state, Err(ConnectionFailure::ProtocolError));
    }

    #[test]
    fn status_snapshot_wire_accepts_the_aliases_projection() {
        let raw = json!({
            "sequence": 5,
            "modelDataPlane": "running",
            "provider": "configured",
            "aliases": {
                "revision": 3,
                "path": "C:\\app\\data\\model-aliases.json",
                "present": true,
                "valid": true,
                "defaultsVersion": 1,
                "error": null
            }
        });
        let status = decode_status_snapshot(&raw).expect("status with aliases must decode");
        let aliases = status
            .aliases
            .as_ref()
            .expect("aliases projection must flow through");
        assert_eq!(aliases.revision, 3);
        assert!(aliases.present);
        assert!(aliases.valid);
        assert_eq!(aliases.defaults_version, 1);
        // The sanitized projection round-trips into the renderer payload
        // exactly (camelCase key, no leaked content beyond the projection).
        assert_eq!(
            serde_json::to_value(&status).expect("serialize status"),
            json!({
                "sequence": 5,
                "modelDataPlane": "running",
                "provider": "configured",
                "aliases": {
                    "revision": 3,
                    "path": "C:\\app\\data\\model-aliases.json",
                    "present": true,
                    "valid": true,
                    "defaultsVersion": 1
                }
            })
        );
        // A malformed aliases projection still rejects the whole snapshot.
        assert!(decode_status_snapshot(&json!({
            "sequence": 6,
            "modelDataPlane": "running",
            "provider": "configured",
            "aliases": {"revision": 3}
        }))
        .is_none());
    }
}
