#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod control_plane_v1;
mod native_discovery;
mod shell_bridge;
mod tray_lifecycle;
mod tray_surface;

use std::sync::Arc;

use control_plane_v1::{
    AutoStartAction, CatalogCommand, CatalogCommandResultWire, ClientTokenCommand,
    ClientTokenCommandResultWire, ClientTokenScopeWire, CredentialCommand,
    CredentialCommandResultWire, CredentialImportSelectionWire, DiagnosticsWarningWire,
    ModelsCommand, NativeControlPlaneConnector, RequestIdentityRecordWire, RuntimeCommand,
    SettingsCommand,
};
use native_discovery::NativeControlPlaneDiscovery;
use shell_bridge::{
    AutoStartDto, ShellBridge, ShellStateDto, ShellStateEmitter, TauriMainWindowEmitter,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};
use tray_surface::{TrayStateEmitter, TRAY_ID, TRAY_QUIT_ID, TRAY_SHOW_ID};

#[tauri::command]
async fn shell_snapshot(state: State<'_, ShellBridge>) -> Result<ShellStateDto, ()> {
    Ok(state.snapshot().await)
}

#[tauri::command]
async fn shell_retry(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    Ok(state.retry(shell_emitter(app)).await)
}

async fn run_runtime_command(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
    command: RuntimeCommand,
) -> Result<ShellStateDto, ()> {
    Ok(state.runtime_command(command, shell_emitter(app)).await)
}

#[tauri::command]
async fn shell_start(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    run_runtime_command(app, state, RuntimeCommand::Start).await
}

#[tauri::command]
async fn shell_stop(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    run_runtime_command(app, state, RuntimeCommand::Stop).await
}

#[tauri::command]
async fn shell_restart(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    run_runtime_command(app, state, RuntimeCommand::Restart).await
}

async fn run_settings_command(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
    command: SettingsCommand,
) -> Result<ShellStateDto, ()> {
    Ok(state.settings_command(command, shell_emitter(app)).await)
}

async fn run_auto_start_command(
    state: State<'_, ShellBridge>,
    action: AutoStartAction,
) -> Result<AutoStartDto, ()> {
    state.auto_start(action).await
}

#[tauri::command]
async fn shell_auto_start_status(state: State<'_, ShellBridge>) -> Result<AutoStartDto, ()> {
    run_auto_start_command(state, AutoStartAction::Status).await
}

#[tauri::command]
async fn shell_auto_start_enable(state: State<'_, ShellBridge>) -> Result<AutoStartDto, ()> {
    run_auto_start_command(state, AutoStartAction::Enable).await
}

#[tauri::command]
async fn shell_auto_start_disable(state: State<'_, ShellBridge>) -> Result<AutoStartDto, ()> {
    run_auto_start_command(state, AutoStartAction::Disable).await
}

#[tauri::command]
async fn shell_settings_query(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    run_settings_command(app, state, SettingsCommand::Query).await
}

#[tauri::command]
async fn shell_settings_set(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    run_settings_command(app, state, SettingsCommand::Set).await
}

#[tauri::command]
async fn shell_settings_confirm(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    run_settings_command(app, state, SettingsCommand::Confirm).await
}

#[tauri::command]
async fn shell_client_tokens_list(
    state: State<'_, ShellBridge>,
    protocol_id: String,
) -> Result<ClientTokenCommandResultWire, ()> {
    state
        .client_token_command(ClientTokenCommand::List { protocol_id })
        .await
}

#[tauri::command]
async fn shell_client_tokens_create(
    state: State<'_, ShellBridge>,
    protocol_id: String,
    scope: serde_json::Value,
    token: Option<String>,
) -> Result<ClientTokenCommandResultWire, ()> {
    let scope = parse_client_token_scope(scope)?;
    state
        .client_token_command(ClientTokenCommand::Create {
            protocol_id,
            scope,
            token,
        })
        .await
}

#[tauri::command]
async fn shell_client_tokens_reveal(
    state: State<'_, ShellBridge>,
    protocol_id: String,
    scope: Option<serde_json::Value>,
) -> Result<ClientTokenCommandResultWire, ()> {
    let scope = scope.map(parse_client_token_scope).transpose()?;
    state
        .client_token_command(ClientTokenCommand::Reveal { protocol_id, scope })
        .await
}

#[tauri::command]
async fn shell_client_tokens_rotate(
    state: State<'_, ShellBridge>,
    protocol_id: String,
    expected_revision: u64,
    scope: Option<serde_json::Value>,
    token: Option<String>,
) -> Result<ClientTokenCommandResultWire, ()> {
    let scope = scope.map(parse_client_token_scope).transpose()?;
    state
        .client_token_command(ClientTokenCommand::Rotate {
            protocol_id,
            expected_revision,
            scope,
            token,
        })
        .await
}

#[tauri::command]
async fn shell_client_tokens_remove(
    state: State<'_, ShellBridge>,
    protocol_id: String,
    expected_revision: u64,
    scope: Option<serde_json::Value>,
) -> Result<ClientTokenCommandResultWire, ()> {
    let scope = scope.map(parse_client_token_scope).transpose()?;
    state
        .client_token_command(ClientTokenCommand::Remove {
            protocol_id,
            expected_revision,
            scope,
        })
        .await
}

/// Strict scope decode at the native bridge: `type` is required and
/// `projectDir` is required exactly for project scopes. Raw paths ride
/// verbatim to the backend, which owns canonicalization.
fn parse_client_token_scope(value: serde_json::Value) -> Result<ClientTokenScopeWire, ()> {
    let Some(object) = value.as_object() else {
        return Err(());
    };
    match object.get("type").and_then(serde_json::Value::as_str) {
        Some("global") if object.get("projectDir").is_none() => Ok(ClientTokenScopeWire {
            scope_type: "global".to_owned(),
            project_dir: None,
        }),
        Some("project") => {
            let project_dir = object
                .get("projectDir")
                .and_then(serde_json::Value::as_str)
                .filter(|dir| !dir.is_empty());
            match project_dir {
                Some(project_dir) => Ok(ClientTokenScopeWire {
                    scope_type: "project".to_owned(),
                    project_dir: Some(project_dir.to_owned()),
                }),
                None => Err(()),
            }
        }
        _ => Err(()),
    }
}

#[tauri::command]
async fn shell_pick_directory(app: tauri::AppHandle) -> Result<Option<String>, ()> {
    use tauri_plugin_dialog::DialogExt;
    // The desktop Rust shell owns the native picker interaction; the raw
    // picked path is returned to the renderer and the backend canonicalizes
    // it at the token-authority boundary. Commands run off the main thread,
    // so the blocking dialog is safe here.
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.map(|path| path.to_string()))
}

#[tauri::command]
async fn shell_request_identities(
    state: State<'_, ShellBridge>,
) -> Result<Vec<RequestIdentityRecordWire>, ()> {
    state.request_identities().await
}

#[tauri::command]
async fn shell_diagnostics_warnings(
    state: State<'_, ShellBridge>,
) -> Result<Vec<DiagnosticsWarningWire>, ()> {
    state.diagnostics_warnings().await
}

#[tauri::command]
async fn shell_credentials_query(
    state: State<'_, ShellBridge>,
) -> Result<CredentialCommandResultWire, ()> {
    state.credential_command(CredentialCommand::Query).await
}

#[tauri::command]
async fn shell_credentials_login(
    state: State<'_, ShellBridge>,
    provider_id: String,
    expected_revision: u64,
    value: String,
    overwrite: bool,
) -> Result<CredentialCommandResultWire, ()> {
    state
        .credential_command(CredentialCommand::Login {
            provider_id,
            expected_revision,
            value,
            overwrite,
        })
        .await
}

#[tauri::command]
async fn shell_credentials_logout(
    state: State<'_, ShellBridge>,
    provider_id: String,
    expected_revision: u64,
) -> Result<CredentialCommandResultWire, ()> {
    state
        .credential_command(CredentialCommand::Logout {
            provider_id,
            expected_revision,
        })
        .await
}

#[tauri::command]
async fn shell_credentials_import_preview(
    state: State<'_, ShellBridge>,
    expected_revision: u64,
    content: String,
) -> Result<CredentialCommandResultWire, ()> {
    state
        .credential_command(CredentialCommand::ImportPreview {
            expected_revision,
            content,
        })
        .await
}

#[tauri::command]
async fn shell_credentials_import_apply(
    state: State<'_, ShellBridge>,
    expected_revision: u64,
    import_id: String,
    selections: Vec<CredentialImportSelectionWire>,
) -> Result<CredentialCommandResultWire, ()> {
    state
        .credential_command(CredentialCommand::ImportApply {
            expected_revision,
            import_id,
            selections,
        })
        .await
}

async fn run_models_command(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
    command: ModelsCommand,
) -> Result<ShellStateDto, ()> {
    Ok(state.models_command(command, shell_emitter(app)).await)
}

#[tauri::command]
async fn shell_catalog_query(
    state: State<'_, ShellBridge>,
) -> Result<CatalogCommandResultWire, ()> {
    state.catalog_command(CatalogCommand::Query).await
}

#[tauri::command]
async fn shell_catalog_refresh(
    state: State<'_, ShellBridge>,
    mode: String,
) -> Result<CatalogCommandResultWire, ()> {
    match mode.as_str() {
        "background" => {
            state
                .catalog_command(CatalogCommand::RefreshBackground)
                .await
        }
        "manual" => state.catalog_command(CatalogCommand::RefreshManual).await,
        _ => Err(()),
    }
}

#[tauri::command]
async fn shell_models_query(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    run_models_command(app, state, ModelsCommand::Query).await
}

#[tauri::command]
async fn shell_models_write_raw(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
    revision: u64,
    content: String,
) -> Result<ShellStateDto, ()> {
    run_models_command(app, state, ModelsCommand::WriteRaw { revision, content }).await
}

#[tauri::command]
async fn shell_models_write_structured(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
    revision: u64,
    providers: serde_json::Value,
) -> Result<ShellStateDto, ()> {
    run_models_command(
        app,
        state,
        ModelsCommand::WriteStructured {
            revision,
            providers,
        },
    )
    .await
}

/// Fans a bridge state emission out to every public surface: the renderer
/// window and the tray. Exactly one bridge operation is ever active (the
/// bridge aborts the previous one on retry), so both surfaces always observe
/// the same revisioned state stream.
struct CompositeEmitter {
    emitters: Vec<Arc<dyn ShellStateEmitter>>,
}

impl ShellStateEmitter for CompositeEmitter {
    fn emit(&self, state: &ShellStateDto) {
        for emitter in &self.emitters {
            emitter.emit(state);
        }
    }
}

fn shell_emitter(app: tauri::AppHandle) -> Arc<dyn ShellStateEmitter> {
    let window: Arc<dyn ShellStateEmitter> = Arc::new(TauriMainWindowEmitter::new(app.clone()));
    let mut emitters: Vec<Arc<dyn ShellStateEmitter>> = vec![window];
    if let Some(tray) = app.try_state::<Arc<TrayStateEmitter>>() {
        let tray: Arc<dyn ShellStateEmitter> = tray.inner().clone();
        emitters.push(tray);
    }
    Arc::new(CompositeEmitter { emitters })
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn quit_application(app: &tauri::AppHandle, bridge: &ShellBridge) {
    let bridge = bridge.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        bridge.shutdown().await;
        app.exit(0);
    });
}

fn main() {
    let app = tauri::Builder::default()
        // Single-instance must be registered first so a second process never
        // initializes a competing Control Plane connection.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // Native system dialogs (Ticket 17): the shell owns the directory
        // picker; the backend owns canonical identity.
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            // Window Close is a hide, never a quit: the application and the
            // Data Plane stay alive and the tray keeps the window reachable.
            // The explicit Quit intent belongs exclusively to the tray Quit
            // command (TRAY_QUIT_ID); Close never aliases to it.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let windows = app.webview_windows();
            if windows.len() != 1 || !windows.contains_key("main") {
                return Err("LuckyToken desktop requires exactly one main window".into());
            }
            let discovery = NativeControlPlaneDiscovery::from_app(app.handle());
            let bridge = ShellBridge::new(Arc::new(NativeControlPlaneConnector::new(discovery)));
            app.manage(bridge.clone());
            // Exactly one tray icon is created once at setup with stable menu
            // item ids; repeated Close/Show cycles never rebuild it, so no
            // tray icon or menu subscription is ever duplicated. The managed
            // TrayStateEmitter keeps the tray icon and menu alive for the
            // whole application lifetime.
            let surface = Arc::new(tray_surface::TraySurface::new());
            app.manage(surface.clone());
            let status_item = MenuItem::with_id(
                app,
                "tray-status",
                surface.current_label(),
                false,
                None::<&str>,
            )?;
            let show_item =
                MenuItem::with_id(app, TRAY_SHOW_ID, "Show LuckyToken", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, TRAY_QUIT_ID, "Quit LuckyToken", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let tray_menu =
                Menu::with_items(app, &[&status_item, &separator, &show_item, &quit_item])?;
            let mut builder = TrayIconBuilder::with_id(TRAY_ID)
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    TRAY_SHOW_ID => show_main_window(app),
                    TRAY_QUIT_ID => {
                        let bridge = app.state::<ShellBridge>().inner().clone();
                        quit_application(app, &bridge);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            let tray = builder.build(app)?;
            let tray_emitter = Arc::new(TrayStateEmitter::new(surface.clone(), status_item, tray));
            app.manage(tray_emitter.clone());
            // One bridge operation serves both surfaces; the automatic Start
            // is the native connector's one-shot gate.
            let bridge_for_task = bridge.clone();
            let emitter = shell_emitter(app.handle().clone());
            tauri::async_runtime::spawn(async move {
                bridge_for_task.retry(emitter).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell_snapshot,
            shell_retry,
            shell_start,
            shell_stop,
            shell_restart,
            shell_settings_query,
            shell_settings_set,
            shell_settings_confirm,
            shell_auto_start_status,
            shell_auto_start_enable,
            shell_auto_start_disable,
            shell_client_tokens_list,
            shell_client_tokens_create,
            shell_client_tokens_reveal,
            shell_client_tokens_rotate,
            shell_client_tokens_remove,
            shell_pick_directory,
            shell_request_identities,
            shell_diagnostics_warnings,
            shell_models_query,
            shell_models_write_raw,
            shell_models_write_structured,
            shell_credentials_query,
            shell_credentials_login,
            shell_credentials_logout,
            shell_credentials_import_preview,
            shell_credentials_import_apply,
            shell_catalog_query,
            shell_catalog_refresh,
        ])
        .build(tauri::generate_context!())
        .expect("LuckyToken desktop runtime failed");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let bridge = app_handle.state::<ShellBridge>().inner().clone();
            tauri::async_runtime::block_on(bridge.shutdown());
        }
    });
}
