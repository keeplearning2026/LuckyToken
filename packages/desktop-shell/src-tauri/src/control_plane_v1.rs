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
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
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

pub(crate) type ConnectFuture =
    Pin<Box<dyn Future<Output = Result<ConnectResult, ConnectionFailure>> + Send + 'static>>;
pub(crate) type CommandFuture =
    Pin<Box<dyn Future<Output = Result<StatusSnapshot, ConnectionFailure>> + Send + 'static>>;
pub(crate) type SettingsCommandFuture = Pin<
    Box<dyn Future<Output = Result<SettingsCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;

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

pub(crate) type ModelsCommandFuture = Pin<
    Box<dyn Future<Output = Result<ModelsCommandResultWire, ConnectionFailure>> + Send + 'static>,
>;

pub(crate) trait ControlPlaneConnector: Send + Sync {
    fn connect(&self) -> ConnectFuture;
    fn command(&self, _command: RuntimeCommand) -> CommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn settings_command(&self, _command: SettingsCommand) -> SettingsCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn auto_start(&self, _action: AutoStartAction) -> AutoStartFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn client_token_command(&self, _command: ClientTokenCommand) -> ClientTokenCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn diagnostics_warnings(&self) -> DiagnosticsWarningsFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn request_identities(&self) -> RequestIdentitiesFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
    fn models_command(&self, _command: ModelsCommand) -> ModelsCommandFuture {
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

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]

pub(crate) struct AutoStartResultWire {
    pub(crate) outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) enabled: Option<bool>,
}

pub(crate) type AutoStartFuture =
    Pin<Box<dyn Future<Output = Result<AutoStartResultWire, ConnectionFailure>> + Send + 'static>>;

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
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::windows::named_pipe::{NamedPipeServer, ServerOptions},
        time::timeout,
    };

    struct TestPipeServer {
        server: NamedPipeServer,
    }

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

    fn test_pipe_name() -> String {
        format!(
            r"\\.\pipe\luckytoken-desktop-test-{}-{}",
            std::process::id(),
            rand_test_suffix()
        )
    }

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

    async fn read_frame_length(reader: &mut NamedPipeServer) -> Result<usize, std::io::Error> {
        let mut header = [0_u8; 4];
        reader.read_exact(&mut header).await?;
        Ok(u32::from_be_bytes(header) as usize)
    }

    async fn write_frame_bytes(
        writer: &mut NamedPipeServer,
        value: &Value,
    ) -> Result<(), std::io::Error> {
        let body = serde_json::to_vec(value).map_err(|_| std::io::ErrorKind::InvalidData)?;
        writer.write_all(&(body.len() as u32).to_be_bytes()).await?;
        writer.write_all(&body).await
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
}
