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

#[derive(Clone, Debug, PartialEq, Eq)]
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
    fn models_command(&self, _command: ModelsCommand) -> ModelsCommandFuture {
        Box::pin(async { Err(ConnectionFailure::ProtocolError) })
    }
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

    fn test_pipe_name() -> String {
        format!(
            r"\\.\pipe\luckytoken-desktop-test-{}-{}",
            std::process::id(),
            rand_test_suffix()
        )
    }

    fn rand_test_suffix() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the epoch")
            .as_nanos() as u64;
        nanos ^ (nanos >> 32)
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
