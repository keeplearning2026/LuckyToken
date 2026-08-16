use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use serde::Serialize;
use tauri::Emitter;
use tokio::{
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

use crate::control_plane_v1::{
    AliasCommand, AliasCommandResultWire, AuthCommand, AuthCommandResultWire,
    AuthInteractionResponse, AuthLoginSession, AutoStartAction, CatalogCommand,
    CatalogCommandResultWire, ClientTokenCommand, ClientTokenCommandResultWire, ConnectResult,
    ConnectionFailure, ControlPlaneConnector, ControlPlaneSession, CredentialCommand,
    CredentialCommandResultWire, DiagnosticsWarningWire, ModelsCommand, ModelsCommandResultWire,
    ModelsProjectionWire, RequestIdentityRecordWire, RequestLedgerResultWire, RequestLedgerSession,
    RuntimeCommand, SessionFailure, SettingsCommand, StatusSnapshot, CONTROL_PLANE_VERSION,
};

use serde_json::Value;

const SHELL_STATE_EVENT: &str = "luckytoken://shell-state";
/// Renderer channel for typed Provider-auth interaction events (Ticket 13):
/// the bridge forwards allowlisted events here while a login is pending.
const AUTH_EVENT: &str = "luckytoken://auth-event";
/// Renderer channel for typed Request Ledger committed-record events
/// (Ticket 19): the bridge forwards allowlisted records here while a ledger
/// subscription is active.
const LEDGER_EVENT: &str = "luckytoken://ledger-event";

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct AutoStartDto {
    pub(crate) enabled: bool,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        models: Option<Box<ModelsCommandResultWire>>,
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
                models,
                ..
            } => Self::Connected {
                revision: next,
                application_version,
                contract_version,
                snapshot,
                models,
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

/// Typed Provider-auth interaction events forwarded to the renderer
/// (Ticket 13). The payload is opaque JSON that the renderer strictly
/// re-decodes; the bridge is a trust boundary.
pub(crate) trait AuthEventEmitter: Send + Sync {
    fn emit(&self, event: &serde_json::Value);
}

/// Typed Request Ledger committed-record events forwarded to the renderer
/// (Ticket 19). Each payload is a strictly allowlisted record; the renderer
/// re-decodes it — the bridge is a trust boundary.
pub(crate) trait LedgerEventEmitter: Send + Sync {
    fn emit(&self, record: &serde_json::Value);
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

pub(crate) struct TauriAuthEventEmitter {
    app: tauri::AppHandle,
}

impl TauriAuthEventEmitter {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl AuthEventEmitter for TauriAuthEventEmitter {
    fn emit(&self, event: &serde_json::Value) {
        let _ = self.app.emit_to("main", AUTH_EVENT, event);
    }
}

pub(crate) struct TauriLedgerEventEmitter {
    app: tauri::AppHandle,
}

impl TauriLedgerEventEmitter {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl LedgerEventEmitter for TauriLedgerEventEmitter {
    fn emit(&self, record: &serde_json::Value) {
        let _ = self.app.emit_to("main", LEDGER_EVENT, record);
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
    /// The one active desktop login flow: the write half used by
    /// `auth_respond`, removed (identity-safely) when that flow ends and
    /// by `shutdown`.
    auth_session: Arc<tokio::sync::Mutex<Option<AuthLoginSession>>>,
    /// Single-flight gate for the public login seam: while one login is
    /// active a second `shell_auth_login` is refused before it can open a
    /// pipe session, so flows never replace or tear each other down.
    auth_login_active: Arc<AtomicBool>,
    /// Per-flow correlation id source: every accepted login gets a
    /// distinct id, so stale responses from earlier flows are rejected.
    auth_login_sequence: Arc<AtomicU64>,
    /// The one active Request Ledger subscription session (Ticket 19): the
    /// write half keeps the subscription pipe open; removed identity-safely
    /// when the reader ends and by `shutdown`.
    ledger_session: Arc<tokio::sync::Mutex<Option<RequestLedgerSession>>>,
    /// Per-subscription correlation id source: every accepted subscription
    /// gets a distinct id, so an old cleanup task can never remove a
    /// different active session.
    ledger_subscribe_sequence: Arc<AtomicU64>,
}

/// RAII single-flight gate: released when the login task ends (including
/// when the command future is dropped), so a refused or aborted login can
/// never leave the seam permanently locked.
struct AuthLoginGate(Arc<AtomicBool>);

impl AuthLoginGate {
    fn acquire(flag: &Arc<AtomicBool>) -> Result<Self, String> {
        if flag.swap(true, Ordering::SeqCst) {
            return Err(
                "Another sign-in is already in progress. Wait for it to finish, then try again."
                    .to_owned(),
            );
        }
        Ok(Self(flag.clone()))
    }
}

impl Drop for AuthLoginGate {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ShellBridge {
    pub(crate) fn new(connector: Arc<dyn ControlPlaneConnector>) -> Self {
        Self {
            connector,
            renderer_state: Arc::new(RendererStateStore::new()),
            lifecycle: Arc::new(OperationLifecycle {
                active: Mutex::new(None),
            }),
            auth_session: Arc::new(tokio::sync::Mutex::new(None)),
            auth_login_active: Arc::new(AtomicBool::new(false)),
            auth_login_sequence: Arc::new(AtomicU64::new(0)),
            ledger_session: Arc::new(tokio::sync::Mutex::new(None)),
            ledger_subscribe_sequence: Arc::new(AtomicU64::new(0)),
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
                            models: None,
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
                            models: None,
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

    pub(crate) async fn models_command(
        &self,
        command: ModelsCommand,
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
        match self.connector.models_command(command).await {
            Ok(result) => {
                // Merge the authoritative models state into the current
                // snapshot's sanitized projection; the full result (raw
                // content and providers) rides on the DTO for the editors.
                let mut merged = current_snapshot.clone();
                merged.models = Some(ModelsProjectionWire {
                    revision: result.state.revision,
                    path: result.state.path.clone(),
                    present: result.state.present,
                    valid: result.state.valid,
                    error: result.state.error.clone(),
                });
                self.renderer_state
                    .replace(
                        emitter.as_ref(),
                        ShellStateDto::Connected {
                            revision: 0,
                            application_version,
                            contract_version: CONTROL_PLANE_VERSION,
                            snapshot: merged,
                            models: Some(Box::new(result)),
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

    pub(crate) async fn auto_start(&self, action: AutoStartAction) -> Result<AutoStartDto, ()> {
        match self.connector.auto_start(action).await {
            Ok(result) if result.outcome == "ok" => Ok(AutoStartDto {
                enabled: result.enabled.unwrap_or(false),
            }),
            _ => Err(()),
        }
    }

    /// Ticket 16: versioned Client Token commands for the Client Tokens page.
    /// The result is returned to the renderer as-is; list/mutation results
    /// carry masked scopes only and Reveal returns exactly the requested
    /// active secret.
    pub(crate) async fn client_token_command(
        &self,
        command: ClientTokenCommand,
    ) -> Result<ClientTokenCommandResultWire, ()> {
        self.connector
            .client_token_command(command)
            .await
            .map_err(|_| ())
    }

    /// Ticket 12: versioned Credential commands for the Credentials page.
    /// The sanitized projection and closed outcomes are returned as-is;
    /// credential values never cross this bridge.
    pub(crate) async fn credential_command(
        &self,
        command: CredentialCommand,
    ) -> Result<CredentialCommandResultWire, ()> {
        self.connector
            .credential_command(command)
            .await
            .map_err(|_| ())
    }

    /// Ticket 13: one-shot auth query — the per-Provider login options
    /// plus the refreshed effective authentication status.
    pub(crate) async fn auth_query(&self) -> Result<AuthCommandResultWire, ()> {
        self.connector.auth_query().await.map_err(|_| ())
    }

    /// Ticket 13: long-lived Provider-owned login. Typed interaction
    /// events are forwarded to the renderer as they arrive; the future
    /// resolves with the terminal result (success, cancelled, failure).
    ///
    /// Single-flight at the public seam: while one login is active a
    /// second login is refused with an actionable value-free message
    /// before it can open a pipe session, so flows never replace or tear
    /// each other down. Every accepted login carries its own correlation
    /// id. Cleanup is identity-safe: the terminal path only closes the
    /// session this task installed, so an old task can never remove a
    /// different active session.
    pub(crate) async fn auth_login(
        &self,
        provider_id: String,
        auth_type: String,
        emitter: Arc<dyn AuthEventEmitter>,
    ) -> Result<AuthCommandResultWire, String> {
        let _gate = AuthLoginGate::acquire(&self.auth_login_active)?;
        let request_id = format!(
            "desktop-auth-login-{}",
            self.auth_login_sequence.fetch_add(1, Ordering::SeqCst)
        );
        let command = AuthCommand::Login {
            provider_id,
            auth_type,
            request_id: request_id.clone(),
        };
        let start = {
            let emitter = emitter.clone();
            self.connector
                .auth_login(command, Box::new(move |event| emitter.emit(&event)))
                .await
                .map_err(|_| {
                    "The Control Plane could not start the sign-in flow. Check that LuckyToken is running and try again."
                        .to_owned()
                })?
        };
        let session = start.session;
        {
            let mut active = self.auth_session.lock().await;
            let _ = active.replace(session);
        }
        let outcome = match start.result.await {
            Ok(Ok(outcome)) => outcome,
            _ => {
                return Err("The sign-in flow did not complete. Cancel and try again.".to_owned());
            }
        };
        // Identity-safe cleanup: the single-flight gate guarantees this
        // task is the only login, but the check keeps an old task from
        // ever removing a different active session.
        let mut active = self.auth_session.lock().await;
        if active
            .as_ref()
            .is_some_and(|session| session.request_id() == request_id)
        {
            active.take();
        }
        Ok(outcome)
    }

    /// Ticket 13: routes one typed response (prompt answer or cancel) into
    /// the active login flow. Without an active flow the response is
    /// rejected; a `prompt_response` whose prompt id is not the active
    /// flow's current pending prompt (a stale response from an earlier
    /// flow, or a duplicate) is rejected locally and never written.
    pub(crate) async fn auth_respond(
        &self,
        response: &AuthInteractionResponse,
    ) -> Result<(), String> {
        let mut active = self.auth_session.lock().await;
        let Some(session) = active.as_mut() else {
            return Err("There is no active sign-in to respond to.".to_owned());
        };
        match session.respond(response).await {
            Ok(()) => Ok(()),
            Err(ConnectionFailure::ProtocolError) => Err(
                "The sign-in is no longer waiting for that response. Continue the current sign-in or cancel it."
                    .to_owned(),
            ),
            Err(_) => Err("The sign-in connection was lost. Cancel and try again.".to_owned()),
        }
    }

    /// Sanitized Dashboard warnings: a one-shot diagnostics query restricted
    /// to warning-or-worse records; the backend redaction boundary has
    /// already scrubbed credentials before they leave the Control Plane.
    pub(crate) async fn diagnostics_warnings(&self) -> Result<Vec<DiagnosticsWarningWire>, ()> {
        self.connector.diagnostics_warnings().await.map_err(|_| ())
    }

    /// Ticket 11: versioned catalog commands (query / background / manual
    /// refresh). The result carries only the sanitized active catalog
    /// snapshot and bounded per-Provider refresh results; the renderer
    /// re-validates the payload strictly.
    pub(crate) async fn catalog_command(
        &self,
        command: CatalogCommand,
    ) -> Result<CatalogCommandResultWire, ()> {
        self.connector
            .catalog_command(command)
            .await
            .map_err(|_| ())
    }

    /// Ticket 14: versioned alias registry commands (query / write with a
    /// compare-and-swap revision). The result carries only the sanitized
    /// authoritative state projection; the renderer re-validates strictly.
    pub(crate) async fn alias_command(
        &self,
        command: AliasCommand,
    ) -> Result<AliasCommandResultWire, ()> {
        self.connector.alias_command(command).await.map_err(|_| ())
    }

    /// Ticket 17 identity seam: the recent authorized request identities
    /// (optional client session id, canonical project context). The native
    /// bridge rejects records carrying the internal effective session id
    /// before they can reach the renderer.
    pub(crate) async fn request_identities(&self) -> Result<Vec<RequestIdentityRecordWire>, ()> {
        self.connector.request_identities().await.map_err(|_| ())
    }

    /// Ticket 19: bounded newest-first Request Ledger query. The query
    /// object is forwarded verbatim; the host validates it strictly.
    pub(crate) async fn request_ledger_query(
        &self,
        query: Option<Value>,
    ) -> Result<RequestLedgerResultWire, ()> {
        self.connector
            .request_ledger_query(query)
            .await
            .map_err(|_| ())
    }

    /// Ticket 19: long-lived Request Ledger subscription. Any previous
    /// session is replaced (dropping it aborts its reader and closes its
    /// pipe), then a fresh session is opened; the command resolves only
    /// after the host confirmed `subscribed`, so the renderer's
    /// listen-first ordering holds. A cleanup task removes the session
    /// identity-safely when its reader ends, so an old task can never
    /// remove a different active session.
    pub(crate) async fn request_ledger_subscribe(
        &self,
        emitter: Arc<dyn LedgerEventEmitter>,
    ) -> Result<(), String> {
        let request_id = format!(
            "desktop-ledger-subscribe-{}",
            self.ledger_subscribe_sequence
                .fetch_add(1, Ordering::SeqCst)
        );
        let start = {
            let emitter = emitter.clone();
            self.connector
                .request_ledger_subscribe(
                    request_id.clone(),
                    Box::new(move |record| emitter.emit(&record)),
                )
                .await
                .map_err(|_| {
                    "The Control Plane could not start the request ledger subscription. Check that LuckyToken is running and try again."
                        .to_owned()
                })?
        };
        {
            let mut active = self.ledger_session.lock().await;
            let _ = active.replace(start.session);
        }
        // Identity-safe cleanup: when the reader ends, only remove this
        // session — a replaced subscription is never torn down by an old
        // task.
        let ledger_session = self.ledger_session.clone();
        let session_request_id = request_id;
        tokio::spawn(async move {
            let _ = start.ended.await;
            let mut active = ledger_session.lock().await;
            if active
                .as_ref()
                .is_some_and(|session| session.request_id() == session_request_id)
            {
                active.take();
            }
        });
        Ok(())
    }

    /// Ticket 19: ends the active ledger subscription (no-op without one).
    /// Dropping the session aborts its reader loop and closes its pipe, so
    /// the host stops the per-connection fan-out.
    pub(crate) async fn request_ledger_unsubscribe(&self) {
        self.ledger_session.lock().await.take();
    }

    pub(crate) async fn shutdown(&self) {
        let mut active = self.lifecycle.active.lock().await;
        abort_and_join(active.take()).await;
        // Closing the auth session aborts its reader loop and pipe: the
        // host aborts any Provider-owned flow still pending.
        self.auth_session.lock().await.take();
        // Closing the ledger session aborts its reader loop and pipe: the
        // host stops the per-connection ledger fan-out.
        self.ledger_session.lock().await.take();
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
                        models: None,
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
                                    models: None,
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
        execute_auth_login_session, AuthCommand, AuthLoginFuture, AutoStartFuture,
        AutoStartResultWire, ConnectFuture, ConnectResult, ConnectionFailure,
        ControlPlaneConnector, ControlPlaneSession, ModelDataPlaneState, ProviderState,
        SessionFailure, StatusSnapshot,
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
            ownership: None,

            models: None,
            aliases: None,
            credentials: None,
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
                ownership: None,

                models: None,
                aliases: None,
                credentials: None,
            }),
            models: None,
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
    async fn auto_start_actions_route_to_the_native_connector_and_return_the_dto() {
        let actions = Arc::new(std::sync::Mutex::new(Vec::<AutoStartAction>::new()));
        let bridge = ShellBridge::new(Arc::new(AutoStartRecordingConnector {
            actions: actions.clone(),
        }));

        let enabled = bridge.auto_start(AutoStartAction::Enable).await;
        let disabled = bridge.auto_start(AutoStartAction::Disable).await;
        let queried = bridge.auto_start(AutoStartAction::Status).await;

        assert!(enabled.expect("enable must succeed").enabled);
        assert!(!disabled.expect("disable must succeed").enabled);
        assert!(!queried.expect("status must succeed").enabled);
        assert_eq!(
            *actions.lock().unwrap(),
            vec![
                AutoStartAction::Enable,
                AutoStartAction::Disable,
                AutoStartAction::Status
            ]
        );
    }

    struct AutoStartRecordingConnector {
        actions: Arc<std::sync::Mutex<Vec<AutoStartAction>>>,
    }

    impl ControlPlaneConnector for AutoStartRecordingConnector {
        fn connect(&self) -> ConnectFuture {
            Box::pin(async { Err(ConnectionFailure::ProtocolError) })
        }

        fn auto_start(&self, action: AutoStartAction) -> AutoStartFuture {
            self.actions.lock().unwrap().push(action);
            let enabled = action == AutoStartAction::Enable;
            Box::pin(async move {
                Ok(AutoStartResultWire {
                    outcome: "ok".to_owned(),
                    enabled: Some(enabled),
                })
            })
        }
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

    struct RecordingAuthEmitter {
        events: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    }

    impl AuthEventEmitter for RecordingAuthEmitter {
        fn emit(&self, event: &serde_json::Value) {
            self.events.lock().unwrap().push(event.clone());
        }
    }

    /// Connector that opens real named pipes for each login (the test
    /// drives the server side, exercising the full relay path).
    struct ScriptedPipeAuthConnector {
        pipes: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl ControlPlaneConnector for ScriptedPipeAuthConnector {
        fn connect(&self) -> ConnectFuture {
            Box::pin(async { Err(ConnectionFailure::ProtocolError) })
        }

        fn auth_login(
            &self,
            command: AuthCommand,
            on_event: Box<dyn FnMut(serde_json::Value) + Send + 'static>,
        ) -> AuthLoginFuture {
            let pipe_name = self
                .pipes
                .lock()
                .unwrap()
                .pop()
                .expect("script has no pipe left");
            Box::pin(async move {
                execute_auth_login_session(
                    &pipe_name,
                    "desktop-test-capability".to_owned(),
                    command,
                    on_event,
                )
                .await
            })
        }
    }

    fn auth_test_pipe_name() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the epoch")
            .as_nanos() as u64;
        format!(
            r"\\.\pipe\luckytoken-desktop-auth-test-{}-{}",
            std::process::id(),
            nanos ^ COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    }

    struct TestAuthPipeServer {
        server: tokio::net::windows::named_pipe::NamedPipeServer,
    }

    impl TestAuthPipeServer {
        async fn next_frame(&mut self) -> serde_json::Value {
            use tokio::io::AsyncReadExt;
            let mut header = [0_u8; 4];
            self.server
                .read_exact(&mut header)
                .await
                .expect("test server must read a frame header");
            let length = u32::from_be_bytes(header) as usize;
            let mut body = vec![0_u8; length];
            self.server
                .read_exact(&mut body)
                .await
                .expect("test server must read a frame body");
            serde_json::from_slice(&body).expect("test server must parse the frame body")
        }

        async fn send(&mut self, value: &serde_json::Value) {
            use tokio::io::AsyncWriteExt;
            let body = serde_json::to_vec(value).expect("test frame must serialize");
            self.server
                .write_all(&(body.len() as u32).to_be_bytes())
                .await
                .expect("test server must write a frame header");
            self.server
                .write_all(&body)
                .await
                .expect("test server must write a frame body");
        }
    }

    async fn accept_auth_login(
        server: &mut TestAuthPipeServer,
        provider_id: &str,
    ) -> (String, String, String) {
        let hello = server.next_frame().await;
        assert_eq!(
            hello.get("type").and_then(serde_json::Value::as_str),
            Some("hello")
        );
        server
            .send(&serde_json::json!({
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
            request.get("type").and_then(serde_json::Value::as_str),
            Some("auth_command")
        );
        let request_id = request
            .get("requestId")
            .and_then(serde_json::Value::as_str)
            .expect("login command must carry a per-flow request id")
            .to_owned();
        assert!(
            request_id.starts_with("desktop-auth-login-"),
            "every accepted login must carry a distinct correlation id"
        );
        let provider = request
            .get("command")
            .and_then(|raw| raw.get("providerId"))
            .and_then(serde_json::Value::as_str)
            .expect("login command must carry the provider id")
            .to_owned();
        let auth_type = request
            .get("command")
            .and_then(|raw| raw.get("authType"))
            .and_then(serde_json::Value::as_str)
            .expect("login command must carry the auth type")
            .to_owned();
        assert_eq!(provider, provider_id);
        (provider, auth_type, request_id)
    }

    #[tokio::test]
    async fn auth_login_forwards_events_and_auth_respond_routes_into_the_active_session() {
        let pipe_name = auth_test_pipe_name();
        let server = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let events = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let emitted = events.clone();
        let bridge = ShellBridge::new(Arc::new(ScriptedPipeAuthConnector {
            pipes: Arc::new(std::sync::Mutex::new(vec![pipe_name.clone()])),
        }));
        let login_task = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .auth_login(
                        "anthropic".to_owned(),
                        "oauth".to_owned(),
                        Arc::new(RecordingAuthEmitter { events: emitted }),
                    )
                    .await
            }
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestAuthPipeServer { server };
        let (_provider, auth_type, request_id) = accept_auth_login(&mut server, "anthropic").await;
        assert_eq!(auth_type, "oauth");

        // Typed events must be forwarded to the renderer, stamped with the
        // flow's own correlation id.
        server
            .send(&serde_json::json!({
                "type": "auth_interaction_event",
                "requestId": request_id,
                "event": {"type": "auth_url", "url": "https://example.com/authorize"}
            }))
            .await;
        server
            .send(&serde_json::json!({
                "type": "auth_interaction_event",
                "requestId": request_id,
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
        assert_eq!(forwarded[0]["type"], serde_json::json!("auth_url"));
        assert_eq!(forwarded[1]["promptId"], serde_json::json!("p1"));

        // A typed response for the outstanding prompt routes into the
        // active session, stamped with the flow's correlation id.
        bridge
            .auth_respond(&AuthInteractionResponse::PromptResponse {
                prompt_id: "p1".to_owned(),
                value: "FAKE-CODE".to_owned(),
            })
            .await
            .expect("response must route into the active session");
        let response = server.next_frame().await;
        assert_eq!(
            response.get("type").and_then(serde_json::Value::as_str),
            Some("auth_interaction_response")
        );
        assert_eq!(
            response
                .get("requestId")
                .and_then(serde_json::Value::as_str),
            Some(request_id.as_str())
        );
        assert_eq!(
            response
                .get("response")
                .and_then(|raw| raw.get("value"))
                .and_then(serde_json::Value::as_str),
            Some("FAKE-CODE")
        );

        // A duplicate of the already-answered prompt is rejected locally:
        // the slot is cleared after the accepted response, so nothing is
        // written a second time.
        assert!(bridge
            .auth_respond(&AuthInteractionResponse::PromptResponse {
                prompt_id: "p1".to_owned(),
                value: "FAKE-CODE".to_owned(),
            })
            .await
            .is_err());
        assert!(timeout(Duration::from_millis(200), server.next_frame(),)
            .await
            .is_err());

        server
            .send(&serde_json::json!({
                "type": "auth_command_result",
                "requestId": request_id,
                "result": {
                    "outcome": "ok",
                    "state": {
                        "revision": 2,
                        "path": "C:\\auth.json",
                        "present": true,
                        "valid": true,
                        "providers": []
                    }
                }
            }))
            .await;

        let result = timeout(Duration::from_secs(5), login_task)
            .await
            .expect("login must complete within the timeout")
            .expect("login task must not panic")
            .expect("login must succeed");
        assert_eq!(result.outcome, "ok");
        bridge.shutdown().await;
    }

    #[tokio::test]
    async fn a_second_concurrent_login_is_refused_before_installing_a_new_session() {
        let pipe_name = auth_test_pipe_name();
        let server = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let pipes = Arc::new(std::sync::Mutex::new(vec![pipe_name.clone()]));
        let bridge = ShellBridge::new(Arc::new(ScriptedPipeAuthConnector {
            pipes: pipes.clone(),
        }));
        let login_a = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .auth_login(
                        "anthropic".to_owned(),
                        "oauth".to_owned(),
                        Arc::new(RecordingAuthEmitter {
                            events: Arc::new(std::sync::Mutex::new(Vec::new())),
                        }),
                    )
                    .await
            }
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestAuthPipeServer { server };
        let (_, _, request_id) = accept_auth_login(&mut server, "anthropic").await;
        // Keep flow A pending on a prompt.
        server
            .send(&serde_json::json!({
                "type": "auth_interaction_event",
                "requestId": request_id,
                "event": {"type": "prompt", "promptId": "p1", "kind": "text", "message": "Enter the code"}
            }))
            .await;

        // A concurrent second login is refused with an actionable message
        // before it can open or replace another pipe session.
        let refusal = bridge
            .auth_login(
                "my-gateway".to_owned(),
                "oauth".to_owned(),
                Arc::new(RecordingAuthEmitter {
                    events: Arc::new(std::sync::Mutex::new(Vec::new())),
                }),
            )
            .await
            .expect_err("a concurrent login must be refused");
        assert!(refusal.contains("already in progress"));
        assert!(
            pipes.lock().unwrap().is_empty(),
            "the refused login must never open a pipe session"
        );

        // Flow A is untouched: its session still routes responses.
        bridge
            .auth_respond(&AuthInteractionResponse::Cancel)
            .await
            .expect("the first login must still accept responses");
        let response = server.next_frame().await;
        assert_eq!(
            response.get("type").and_then(serde_json::Value::as_str),
            Some("auth_interaction_response")
        );
        assert_eq!(
            response
                .get("response")
                .and_then(|raw| raw.get("type"))
                .and_then(serde_json::Value::as_str),
            Some("cancel")
        );

        // After flow A ends the seam accepts a fresh login again.
        server
            .send(&serde_json::json!({
                "type": "auth_command_result",
                "requestId": request_id,
                "result": {
                    "outcome": "cancelled",
                    "state": {
                        "revision": 2,
                        "path": "C:\\auth.json",
                        "present": true,
                        "valid": true,
                        "providers": []
                    },
                    "error": "Sign-in was cancelled"
                }
            }))
            .await;
        timeout(Duration::from_secs(5), login_a)
            .await
            .expect("first login must complete within the timeout")
            .expect("first login task must not panic")
            .expect("first login must finish");
        bridge.shutdown().await;
    }

    #[tokio::test]
    async fn completion_of_an_old_task_cannot_close_a_newer_accepted_session() {
        let pipe_a = auth_test_pipe_name();
        let server_a = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_a)
            .expect("test server must create its pipe");
        let pipe_b = auth_test_pipe_name();
        let server_b = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_b)
            .expect("test server must create its pipe");
        let bridge = ShellBridge::new(Arc::new(ScriptedPipeAuthConnector {
            pipes: Arc::new(std::sync::Mutex::new(vec![pipe_a.clone()])),
        }));
        let login_a = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .auth_login(
                        "anthropic".to_owned(),
                        "oauth".to_owned(),
                        Arc::new(RecordingAuthEmitter {
                            events: Arc::new(std::sync::Mutex::new(Vec::new())),
                        }),
                    )
                    .await
            }
        });
        server_a
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server_a = TestAuthPipeServer { server: server_a };
        let (_, _, request_id_a) = accept_auth_login(&mut server_a, "anthropic").await;

        // Keep flow A pending, then force the slot to hold a newer
        // session while A's own session object stays alive in the test
        // (the single-flight gate normally prevents this; the identity
        // check must hold even then). Moving A's session out of the slot
        // keeps its reader running, so A can still complete normally.
        let start_b_task = tokio::spawn(async move {
            execute_auth_login_session(
                &pipe_b,
                "desktop-test-capability".to_owned(),
                AuthCommand::Login {
                    provider_id: "my-gateway".to_owned(),
                    auth_type: "oauth".to_owned(),
                    request_id: "desktop-auth-login-999".to_owned(),
                },
                |_| {},
            )
            .await
            .expect("the newer session must negotiate")
        });
        server_b
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server_b = TestAuthPipeServer { server: server_b };
        let (_, _, request_id_b) = accept_auth_login(&mut server_b, "my-gateway").await;
        assert_eq!(request_id_b, "desktop-auth-login-999");
        let start_b = timeout(Duration::from_secs(5), start_b_task)
            .await
            .expect("the newer session must start within the timeout")
            .expect("the newer session task must not panic");
        let held_a = bridge.auth_session.lock().await.replace(start_b.session);
        let held_a = held_a.expect("flow A's session must be installed");

        // Flow A completes normally: its identity-safe cleanup must not
        // remove the newer session from the slot.
        server_a
            .send(&serde_json::json!({
                "type": "auth_command_result",
                "requestId": request_id_a,
                "result": {
                    "outcome": "ok",
                    "state": {
                        "revision": 2,
                        "path": "C:\\auth.json",
                        "present": true,
                        "valid": true,
                        "providers": []
                    }
                }
            }))
            .await;
        timeout(Duration::from_secs(5), login_a)
            .await
            .expect("first login must complete within the timeout")
            .expect("first login task must not panic")
            .expect("first login must succeed");

        let slot = bridge.auth_session.lock().await;
        let remaining = slot
            .as_ref()
            .expect("the newer session must still be installed");
        assert_eq!(
            remaining.request_id(),
            "desktop-auth-login-999",
            "the old task's completion must never close the newer session"
        );
        drop(slot);
        bridge
            .auth_respond(&AuthInteractionResponse::Cancel)
            .await
            .expect("the newer session must still route responses");
        let response = server_b.next_frame().await;
        assert_eq!(
            response.get("type").and_then(serde_json::Value::as_str),
            Some("auth_interaction_response")
        );
        // Releasing the held flow-A session only aborts its (already
        // completed) reader.
        drop(held_a);
        bridge.shutdown().await;
    }

    #[tokio::test]
    async fn a_stale_prompt_response_is_rejected_and_never_delivered_to_the_current_flow() {
        let pipe_a = auth_test_pipe_name();
        let server_a = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_a)
            .expect("test server must create its pipe");
        let pipe_b = auth_test_pipe_name();
        let server_b = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_b)
            .expect("test server must create its pipe");
        let bridge = ShellBridge::new(Arc::new(ScriptedPipeAuthConnector {
            pipes: Arc::new(std::sync::Mutex::new(vec![pipe_b.clone(), pipe_a.clone()])),
        }));
        let login_a = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .auth_login(
                        "anthropic".to_owned(),
                        "oauth".to_owned(),
                        Arc::new(RecordingAuthEmitter {
                            events: Arc::new(std::sync::Mutex::new(Vec::new())),
                        }),
                    )
                    .await
            }
        });
        server_a
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server_a = TestAuthPipeServer { server: server_a };
        let (_, _, request_id_a) = accept_auth_login(&mut server_a, "anthropic").await;
        // Flow A asks its prompt, then completes cancelled.
        server_a
            .send(&serde_json::json!({
                "type": "auth_interaction_event",
                "requestId": request_id_a,
                "event": {"type": "prompt", "promptId": "stale-prompt-a", "kind": "text", "message": "Enter the code"}
            }))
            .await;
        server_a
            .send(&serde_json::json!({
                "type": "auth_command_result",
                "requestId": request_id_a,
                "result": {
                    "outcome": "cancelled",
                    "state": {
                        "revision": 2,
                        "path": "C:\\auth.json",
                        "present": true,
                        "valid": true,
                        "providers": []
                    },
                    "error": "Sign-in was cancelled"
                }
            }))
            .await;
        timeout(Duration::from_secs(5), login_a)
            .await
            .expect("first login must complete within the timeout")
            .expect("first login task must not panic")
            .expect("first login must finish");

        // Flow B is accepted afterwards with its own correlation id.
        let login_b = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .auth_login(
                        "anthropic".to_owned(),
                        "oauth".to_owned(),
                        Arc::new(RecordingAuthEmitter {
                            events: Arc::new(std::sync::Mutex::new(Vec::new())),
                        }),
                    )
                    .await
            }
        });
        server_b
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server_b = TestAuthPipeServer { server: server_b };
        let (_, _, request_id_b) = accept_auth_login(&mut server_b, "anthropic").await;
        assert_ne!(
            request_id_a, request_id_b,
            "flows must not share correlation ids"
        );
        server_b
            .send(&serde_json::json!({
                "type": "auth_interaction_event",
                "requestId": request_id_b,
                "event": {"type": "prompt", "promptId": "current-prompt-b", "kind": "text", "message": "Enter the code"}
            }))
            .await;

        // A response carrying flow A's prompt id is rejected locally and
        // never written to flow B's pipe.
        let stale = bridge
            .auth_respond(&AuthInteractionResponse::PromptResponse {
                prompt_id: "stale-prompt-a".to_owned(),
                value: "FAKE-CODE".to_owned(),
            })
            .await
            .expect_err("a stale prompt response must be rejected");
        assert!(stale.contains("no longer waiting"));
        assert!(
            timeout(Duration::from_millis(200), server_b.next_frame())
                .await
                .is_err(),
            "the stale response must never reach the current flow"
        );

        // The current flow's own prompt still routes normally.
        bridge
            .auth_respond(&AuthInteractionResponse::PromptResponse {
                prompt_id: "current-prompt-b".to_owned(),
                value: "FAKE-CODE".to_owned(),
            })
            .await
            .expect("the current prompt response must route");
        let response = server_b.next_frame().await;
        assert_eq!(
            response.get("type").and_then(serde_json::Value::as_str),
            Some("auth_interaction_response")
        );
        assert_eq!(
            response
                .get("requestId")
                .and_then(serde_json::Value::as_str),
            Some(request_id_b.as_str())
        );
        assert_eq!(
            response
                .get("response")
                .and_then(|raw| raw.get("promptId"))
                .and_then(serde_json::Value::as_str),
            Some("current-prompt-b")
        );

        server_b
            .send(&serde_json::json!({
                "type": "auth_command_result",
                "requestId": request_id_b,
                "result": {
                    "outcome": "ok",
                    "state": {
                        "revision": 2,
                        "path": "C:\\auth.json",
                        "present": true,
                        "valid": true,
                        "providers": []
                    }
                }
            }))
            .await;
        timeout(Duration::from_secs(5), login_b)
            .await
            .expect("second login must complete within the timeout")
            .expect("second login task must not panic")
            .expect("second login must succeed");
        bridge.shutdown().await;
    }

    #[tokio::test]
    async fn auth_respond_without_an_active_login_is_rejected() {
        let bridge = ShellBridge::new(Arc::new(ScriptedPipeAuthConnector {
            pipes: Arc::new(std::sync::Mutex::new(Vec::new())),
        }));
        let rejection = bridge
            .auth_respond(&AuthInteractionResponse::Cancel)
            .await
            .expect_err("a response without an active login must be rejected");
        assert!(rejection.contains("no active sign-in"));
        bridge.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_aborts_an_active_login_and_joins_bounded() {
        let pipe_name = auth_test_pipe_name();
        let server = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("test server must create its pipe");
        let bridge = ShellBridge::new(Arc::new(ScriptedPipeAuthConnector {
            pipes: Arc::new(std::sync::Mutex::new(vec![pipe_name.clone()])),
        }));
        let login_task = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .auth_login(
                        "anthropic".to_owned(),
                        "oauth".to_owned(),
                        Arc::new(RecordingAuthEmitter {
                            events: Arc::new(std::sync::Mutex::new(Vec::new())),
                        }),
                    )
                    .await
            }
        });
        server
            .connect()
            .await
            .expect("test server must accept the client");
        let mut server = TestAuthPipeServer { server };
        let _ = accept_auth_login(&mut server, "anthropic").await;

        timeout(Duration::from_secs(1), bridge.shutdown())
            .await
            .expect("shutdown is bounded while a login is pending");
        timeout(Duration::from_secs(5), login_task)
            .await
            .expect("login must abort within the timeout")
            .expect("login task must not panic")
            .expect_err("shutdown must abort the pending login");
    }
}
