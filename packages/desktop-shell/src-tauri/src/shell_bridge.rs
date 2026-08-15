use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use tokio::{
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

use crate::control_plane_v1::{
    ConnectResult, ConnectionFailure, ControlPlaneConnector, ControlPlaneSession, RuntimeCommand,
    SessionFailure, SettingsCommand, StatusSnapshot, CONTROL_PLANE_VERSION,
};

const SHELL_STATE_EVENT: &str = "luckytoken://shell-state";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UnavailableReason {
    DescriptorMissing,
    DescriptorInvalid,
    PipeUnavailable,
    ProtocolError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DisconnectReason {
    TransportLost,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "connection", rename_all = "snake_case")]
pub(crate) enum ShellStateDto {
    Connected {
        revision: u64,
        #[serde(rename = "applicationVersion")]
        application_version: String,
        #[serde(rename = "contractVersion")]
        contract_version: u64,
        snapshot: Box<StatusSnapshot>,
    },
    VersionMismatch {
        revision: u64,
        #[serde(rename = "requestedVersion")]
        requested_version: u64,
        #[serde(rename = "supportedVersions")]
        supported_versions: Vec<u64>,
    },
    Unavailable {
        revision: u64,
        reason: UnavailableReason,
    },
    Disconnected {
        revision: u64,
        reason: DisconnectReason,
    },
}

impl ShellStateDto {
    fn with_revision(self, next: u64) -> Self {
        match self {
            Self::Connected {
                application_version,
                contract_version,
                snapshot,
                ..
            } => Self::Connected {
                revision: next,
                application_version,
                contract_version,
                snapshot,
            },
            Self::VersionMismatch {
                requested_version,
                supported_versions,
                ..
            } => Self::VersionMismatch {
                revision: next,
                requested_version,
                supported_versions,
            },
            Self::Unavailable { reason, .. } => Self::Unavailable {
                revision: next,
                reason,
            },
            Self::Disconnected { reason, .. } => Self::Disconnected {
                revision: next,
                reason,
            },
        }
    }
}

pub(crate) trait ShellStateEmitter: Send + Sync {
    fn emit(&self, state: &ShellStateDto);
}

pub(crate) struct TauriMainWindowEmitter {
    app: tauri::AppHandle,
}

impl TauriMainWindowEmitter {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ShellStateEmitter for TauriMainWindowEmitter {
    fn emit(&self, state: &ShellStateDto) {
        let _ = self.app.emit_to("main", SHELL_STATE_EVENT, state);
    }
}

struct RendererState {
    revision: u64,
    current: ShellStateDto,
}

struct RendererStateStore {
    inner: Mutex<RendererState>,
}

impl RendererStateStore {
    fn new() -> Self {
        Self {
            inner: Mutex::new(RendererState {
                revision: 0,
                current: ShellStateDto::Unavailable {
                    revision: 0,
                    reason: UnavailableReason::DescriptorMissing,
                },
            }),
        }
    }

    async fn snapshot(&self) -> ShellStateDto {
        self.inner.lock().await.current.clone()
    }

    async fn replace(
        &self,
        emitter: &dyn ShellStateEmitter,
        state: ShellStateDto,
    ) -> ShellStateDto {
        let next = {
            let mut inner = self.inner.lock().await;
            inner.revision += 1;
            let next = state.with_revision(inner.revision);
            inner.current = next.clone();
            next
        };
        emitter.emit(&next);
        next
    }
}

struct OperationLifecycle {
    active: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub(crate) struct ShellBridge {
    connector: Arc<dyn ControlPlaneConnector>,
    renderer_state: Arc<RendererStateStore>,
    lifecycle: Arc<OperationLifecycle>,
}

impl ShellBridge {
    pub(crate) fn new(connector: Arc<dyn ControlPlaneConnector>) -> Self {
        Self {
            connector,
            renderer_state: Arc::new(RendererStateStore::new()),
            lifecycle: Arc::new(OperationLifecycle {
                active: Mutex::new(None),
            }),
        }
    }

    pub(crate) async fn snapshot(&self) -> ShellStateDto {
        self.renderer_state.snapshot().await
    }

    pub(crate) async fn retry(&self, emitter: Arc<dyn ShellStateEmitter>) -> ShellStateDto {
        let (initial_sender, initial_receiver) = oneshot::channel();
        {
            let mut active = self.lifecycle.active.lock().await;
            abort_and_join(active.take()).await;
            let connector = self.connector.clone();
            let renderer_state = self.renderer_state.clone();
            *active = Some(tokio::spawn(async move {
                run_operation(connector, emitter, renderer_state, initial_sender).await;
            }));
        }
        // The automatic Start is owned by the native connector's one-shot gate
        // (first successful connection only); renderer Retry reconnects and
        // subscribes without ever repeating it.

        match initial_receiver.await {
            Ok(initial) => initial,
            Err(_) => self.snapshot().await,
        }
    }

    pub(crate) async fn runtime_command(
        &self,
        command: RuntimeCommand,
        emitter: Arc<dyn ShellStateEmitter>,
    ) -> ShellStateDto {
        let application_version = match self.snapshot().await {
            ShellStateDto::Connected {
                application_version,
                ..
            } => application_version,
            current => return current,
        };
        match self.connector.command(command).await {
            Ok(snapshot) => {
                let current = self.snapshot().await;
                match &current {
                    ShellStateDto::Connected {
                        snapshot: current_snapshot,
                        ..
                    } if current_snapshot.sequence >= snapshot.sequence => return current,
                    ShellStateDto::Connected { .. } => {}
                    _ => return current,
                }
                self.renderer_state
                    .replace(
                        emitter.as_ref(),
                        ShellStateDto::Connected {
                            revision: 0,
                            application_version,
                            contract_version: CONTROL_PLANE_VERSION,
                            snapshot: Box::new(snapshot),
                        },
                    )
                    .await
            }
            Err(failure) => {
                self.renderer_state
                    .replace(
                        emitter.as_ref(),
                        ShellStateDto::Unavailable {
                            revision: 0,
                            reason: unavailable_reason(failure),
                        },
                    )
                    .await
            }
        }
    }

    pub(crate) async fn settings_command(
        &self,
        command: SettingsCommand,
        emitter: Arc<dyn ShellStateEmitter>,
    ) -> ShellStateDto {
        let (application_version, current_snapshot) = match self.snapshot().await {
            ShellStateDto::Connected {
                application_version,
                snapshot,
                ..
            } => (application_version, snapshot),
            current => return current,
        };
        match self.connector.settings_command(command).await {
            Ok(result) => {
                // Merge the settings projection into the current snapshot.
                // The projection is authoritative for the registered settings
                // and confirmation; everything else stays as the last status.
                let mut merged = current_snapshot.clone();
                merged.settings = Some(result.settings);
                merged.confirmation = result.confirmation;
                self.renderer_state
                    .replace(
                        emitter.as_ref(),
                        ShellStateDto::Connected {
                            revision: 0,
                            application_version,
                            contract_version: CONTROL_PLANE_VERSION,
                            snapshot: merged,
                        },
                    )
                    .await
            }
            Err(failure) => {
                self.renderer_state
                    .replace(
                        emitter.as_ref(),
                        ShellStateDto::Unavailable {
                            revision: 0,
                            reason: unavailable_reason(failure),
                        },
                    )
                    .await
            }
        }
    }

    pub(crate) async fn shutdown(&self) {
        let mut active = self.lifecycle.active.lock().await;
        abort_and_join(active.take()).await;
    }
}

async fn abort_and_join(task: Option<JoinHandle<()>>) {
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

async fn run_operation(
    connector: Arc<dyn ControlPlaneConnector>,
    emitter: Arc<dyn ShellStateEmitter>,
    renderer_state: Arc<RendererStateStore>,
    initial_sender: oneshot::Sender<ShellStateDto>,
) {
    let connection = connector.connect().await;
    match connection {
        Err(failure) => {
            let state = renderer_state
                .replace(
                    emitter.as_ref(),
                    ShellStateDto::Unavailable {
                        revision: 0,
                        reason: unavailable_reason(failure),
                    },
                )
                .await;
            let _ = initial_sender.send(state);
        }
        Ok(ConnectResult::VersionMismatch {
            requested_version,
            supported_versions,
        }) => {
            let state = renderer_state
                .replace(
                    emitter.as_ref(),
                    ShellStateDto::VersionMismatch {
                        revision: 0,
                        requested_version,
                        supported_versions,
                    },
                )
                .await;
            let _ = initial_sender.send(state);
        }
        Ok(ConnectResult::Connected(session)) => {
            let mut session: Box<dyn ControlPlaneSession> = session;
            let state = renderer_state
                .replace(
                    emitter.as_ref(),
                    ShellStateDto::Connected {
                        revision: 0,
                        application_version: session.application_version().to_owned(),
                        contract_version: CONTROL_PLANE_VERSION,
                        snapshot: Box::new(session.snapshot().clone()),
                    },
                )
                .await;
            let _ = initial_sender.send(state);
            loop {
                match session.next_status().await {
                    Ok(snapshot) => {
                        renderer_state
                            .replace(
                                emitter.as_ref(),
                                ShellStateDto::Connected {
                                    revision: 0,
                                    application_version: session.application_version().to_owned(),
                                    contract_version: CONTROL_PLANE_VERSION,
                                    snapshot: Box::new(snapshot),
                                },
                            )
                            .await;
                    }
                    Err(SessionFailure::TransportLost) => {
                        renderer_state
                            .replace(
                                emitter.as_ref(),
                                ShellStateDto::Disconnected {
                                    revision: 0,
                                    reason: DisconnectReason::TransportLost,
                                },
                            )
                            .await;
                        return;
                    }
                    Err(SessionFailure::ProtocolError) => {
                        renderer_state
                            .replace(
                                emitter.as_ref(),
                                ShellStateDto::Unavailable {
                                    revision: 0,
                                    reason: UnavailableReason::ProtocolError,
                                },
                            )
                            .await;
                        return;
                    }
                }
            }
        }
    }
}

fn unavailable_reason(failure: ConnectionFailure) -> UnavailableReason {
    match failure {
        ConnectionFailure::DescriptorMissing => UnavailableReason::DescriptorMissing,
        ConnectionFailure::DescriptorInvalid => UnavailableReason::DescriptorInvalid,
        ConnectionFailure::PipeUnavailable => UnavailableReason::PipeUnavailable,
        ConnectionFailure::ProtocolError => UnavailableReason::ProtocolError,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane_v1::{
        ConnectFuture, ConnectResult, ConnectionFailure, ControlPlaneConnector,
        ControlPlaneSession, ModelDataPlaneState, ProviderState, SessionFailure, StatusSnapshot,
    };
    use std::pin::Pin;
    use std::{
        future::Future,
        sync::atomic::{AtomicUsize, Ordering},
        task::{Context, Poll},
        time::Duration,
    };
    use tokio::{sync::Semaphore, time::timeout};

    struct PendingConnector {
        started: Arc<Semaphore>,
        dropped: Arc<AtomicUsize>,
    }

    struct PendingConnect {
        started: Arc<Semaphore>,
        dropped: Arc<AtomicUsize>,
        announced: bool,
    }

    impl Future for PendingConnect {
        type Output = Result<ConnectResult, ConnectionFailure>;

        fn poll(mut self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
            if !self.announced {
                self.announced = true;
                self.started.add_permits(1);
            }
            Poll::Pending
        }
    }

    impl Drop for PendingConnect {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl ControlPlaneConnector for PendingConnector {
        fn connect(&self) -> ConnectFuture {
            Box::pin(PendingConnect {
                started: self.started.clone(),
                dropped: self.dropped.clone(),
                announced: false,
            })
        }
    }

    struct SilentEmitter;

    impl ShellStateEmitter for SilentEmitter {
        fn emit(&self, _state: &ShellStateDto) {}
    }

    struct RecordingEmitter {
        states: std::sync::Arc<std::sync::Mutex<Vec<ShellStateDto>>>,
    }

    impl ShellStateEmitter for RecordingEmitter {
        fn emit(&self, state: &ShellStateDto) {
            self.states.lock().unwrap().push(state.clone());
        }
    }

    struct ConnectSessionScript {
        sessions: Vec<ConnectResult>,
        failures: Vec<ConnectionFailure>,
    }

    impl ConnectSessionScript {
        fn result(&mut self) -> ConnectFuture {
            if let Some(failure) = self.failures.pop() {
                return Box::pin(async move { Err(failure) });
            }
            let session = self
                .sessions
                .pop()
                .expect("script has no session or failure left");
            Box::pin(async move { Ok(session) })
        }
    }

    struct ScriptedConnector {
        script: std::sync::Arc<std::sync::Mutex<ConnectSessionScript>>,
    }

    impl ControlPlaneConnector for ScriptedConnector {
        fn connect(&self) -> ConnectFuture {
            self.script.lock().unwrap().result()
        }
    }

    struct TestConnectedSession {
        application_version: String,
        snapshot: StatusSnapshot,
    }

    impl TestConnectedSession {
        fn new(snapshot: StatusSnapshot) -> Self {
            Self {
                application_version: "native-test".to_owned(),
                snapshot,
            }
        }
    }

    impl ControlPlaneSession for TestConnectedSession {
        fn application_version(&self) -> &str {
            &self.application_version
        }
        fn snapshot(&self) -> &StatusSnapshot {
            &self.snapshot
        }
        fn next_status(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = Result<StatusSnapshot, SessionFailure>> + Send + '_>>
        {
            Box::pin(async { std::future::pending().await })
        }
    }

    fn running_snapshot(sequence: u64) -> StatusSnapshot {
        StatusSnapshot {
            sequence,
            model_data_plane: ModelDataPlaneState::Running,
            provider: ProviderState::Unconfigured,
            data_plane: None,
            settings: None,
            confirmation: None,
        }
    }

    #[tokio::test]
    async fn first_successful_connect_sends_exactly_one_auto_start_and_retry_never_repeats_it() {
        // The script yields one successful connected session per connect;
        // the second connect (a renderer Retry) never auto-starts again.
        let script = Arc::new(std::sync::Mutex::new(ConnectSessionScript {
            sessions: vec![
                ConnectResult::Connected(Box::new(TestConnectedSession::new(running_snapshot(2)))),
                ConnectResult::Connected(Box::new(TestConnectedSession::new(running_snapshot(2)))),
            ],
            failures: Vec::new(),
        }));
        let states = Arc::new(std::sync::Mutex::new(Vec::<ShellStateDto>::new()));
        let connector = Arc::new(ScriptedConnector {
            script: script.clone(),
        });
        let bridge = ShellBridge::new(connector);

        let initial = bridge
            .retry(Arc::new(RecordingEmitter {
                states: states.clone(),
            }))
            .await;
        assert!(
            matches!(initial, ShellStateDto::Connected { revision: 1, .. }),
            "first connection must surface a connected state"
        );
        assert!(
            matches!(
                initial,
                ShellStateDto::Connected { snapshot, .. }
                    if snapshot.sequence == 2
            ),
            "first connection must surface the snapshot of the auto-started session"
        );

        let retried = bridge
            .retry(Arc::new(RecordingEmitter {
                states: states.clone(),
            }))
            .await;
        assert!(
            matches!(retried, ShellStateDto::Connected { revision: 2, .. }),
            "Retry must reconnect and surface a newer revision without a second Start"
        );
        bridge.shutdown().await;

        let states = states.lock().unwrap();
        let connected_states = states
            .iter()
            .filter(|state| matches!(state, ShellStateDto::Connected { .. }))
            .count();
        assert_eq!(
            connected_states, 2,
            "exactly two connected states (initial connect and Retry reconnect) must be emitted"
        );
    }

    #[test]
    fn renderer_state_serialization_is_an_explicit_allowlist() {
        let state = ShellStateDto::Connected {
            revision: 3,
            application_version: "0.1.0".to_owned(),
            contract_version: 1,
            snapshot: Box::new(StatusSnapshot {
                sequence: 2,
                model_data_plane: ModelDataPlaneState::Running,
                provider: ProviderState::Unconfigured,
                data_plane: None,
                settings: None,
                confirmation: None,
            }),
        };

        assert_eq!(
            serde_json::to_value(state).expect("serialize renderer state"),
            serde_json::json!({
                "connection": "connected",
                "revision": 3,
                "applicationVersion": "0.1.0",
                "contractVersion": 1,
                "snapshot": {
                    "sequence": 2,
                    "modelDataPlane": "running",
                    "provider": "unconfigured"
                }
            })
        );
    }

    #[tokio::test]
    async fn retry_and_shutdown_cancel_and_join_pending_handshakes() {
        let started = Arc::new(Semaphore::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let bridge = ShellBridge::new(Arc::new(PendingConnector {
            started: started.clone(),
            dropped: dropped.clone(),
        }));

        let first = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.retry(Arc::new(SilentEmitter)).await }
        });
        started
            .acquire()
            .await
            .expect("first handshake starts")
            .forget();

        let second = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.retry(Arc::new(SilentEmitter)).await }
        });
        started
            .acquire()
            .await
            .expect("second handshake starts")
            .forget();
        assert_eq!(dropped.load(Ordering::SeqCst), 1);

        timeout(Duration::from_secs(1), bridge.shutdown())
            .await
            .expect("shutdown is bounded while the handshake is pending");
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
        first.await.expect("first retry joined");
        second.await.expect("second retry joined");
        assert!(bridge.lifecycle.active.lock().await.is_none());
    }
}
