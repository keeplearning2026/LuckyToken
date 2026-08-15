use std::{future::Future, pin::Pin};

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
    Running,
    Stopping,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderState {
    Configured,
    Unconfigured,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct StatusSnapshot {
    pub(crate) sequence: u64,
    #[serde(rename = "modelDataPlane")]
    pub(crate) model_data_plane: ModelDataPlaneState,
    pub(crate) provider: ProviderState,
}

pub(crate) enum ConnectResult {
    Connected(ConnectedSession),
    VersionMismatch {
        requested_version: u64,
        supported_versions: Vec<u64>,
    },
}

pub(crate) struct ConnectedSession {
    pipe: NamedPipeClient,
    application_version: String,
    snapshot: StatusSnapshot,
}

impl ConnectedSession {
    pub(crate) fn application_version(&self) -> &str {
        &self.application_version
    }

    pub(crate) fn snapshot(&self) -> &StatusSnapshot {
        &self.snapshot
    }

    pub(crate) async fn next_status(&mut self) -> Result<StatusSnapshot, SessionFailure> {
        let value = read_json_frame(&mut self.pipe)
            .await
            .map_err(|failure| match failure {
                FrameFailure::Io => SessionFailure::TransportLost,
                FrameFailure::Protocol => SessionFailure::ProtocolError,
            })?;
        decode_status_event(&value).ok_or(SessionFailure::ProtocolError)
    }
}

pub(crate) type ConnectFuture =
    Pin<Box<dyn Future<Output = Result<ConnectResult, ConnectionFailure>> + Send + 'static>>;

pub(crate) trait ControlPlaneConnector: Send + Sync {
    fn connect(&self) -> ConnectFuture;
}

pub(crate) struct NativeControlPlaneConnector {
    discovery: NativeControlPlaneDiscovery,
}

impl NativeControlPlaneConnector {
    pub(crate) fn new(discovery: NativeControlPlaneDiscovery) -> Self {
        Self { discovery }
    }
}

impl ControlPlaneConnector for NativeControlPlaneConnector {
    fn connect(&self) -> ConnectFuture {
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
            connect_session(&pipe_name, capability).await
        })
    }
}

async fn connect_session(
    pipe_name: &str,
    capability: String,
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
            write_json_frame(
                &mut pipe,
                &json!({"type": "get_status", "requestId": "desktop-status"}),
            )
            .await
            .map_err(FrameFailure::connection_failure)?;
            let status = read_json_frame(&mut pipe)
                .await
                .map_err(FrameFailure::connection_failure)?;
            let snapshot = decode_status_result(&status)?;
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
            Ok(ConnectResult::Connected(ConnectedSession {
                pipe,
                application_version,
                snapshot,
            }))
        }
    }
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

fn decode_status_result(value: &Value) -> Result<StatusSnapshot, ConnectionFailure> {
    if value.get("type").and_then(Value::as_str) != Some("status_result")
        || value.get("requestId").and_then(Value::as_str) != Some("desktop-status")
    {
        return Err(ConnectionFailure::ProtocolError);
    }
    serde_json::from_value(
        value
            .get("snapshot")
            .cloned()
            .ok_or(ConnectionFailure::ProtocolError)?,
    )
    .map_err(|_| ConnectionFailure::ProtocolError)
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
    let snapshot: StatusSnapshot = serde_json::from_value(event.get("snapshot")?.clone()).ok()?;
    (snapshot.sequence == sequence).then_some(snapshot)
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
