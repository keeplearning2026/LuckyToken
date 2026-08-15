#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod control_plane_v1;
mod native_discovery;
mod shell_bridge;

use std::sync::Arc;

use control_plane_v1::{NativeControlPlaneConnector, RuntimeCommand};
use native_discovery::NativeControlPlaneDiscovery;
use shell_bridge::{ShellBridge, ShellStateDto, TauriMainWindowEmitter};
use tauri::{Manager, State};

#[tauri::command]
async fn shell_snapshot(state: State<'_, ShellBridge>) -> Result<ShellStateDto, ()> {
    Ok(state.snapshot().await)
}

#[tauri::command]
async fn shell_retry(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
) -> Result<ShellStateDto, ()> {
    Ok(state
        .retry(Arc::new(TauriMainWindowEmitter::new(app)))
        .await)
}

async fn run_runtime_command(
    app: tauri::AppHandle,
    state: State<'_, ShellBridge>,
    command: RuntimeCommand,
) -> Result<ShellStateDto, ()> {
    Ok(state
        .runtime_command(command, Arc::new(TauriMainWindowEmitter::new(app)))
        .await)
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

fn main() {
    let app = tauri::Builder::default()
        // Single-instance must be registered first so a second process never
        // initializes a competing Control Plane connection.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let bridge = window.state::<ShellBridge>().inner().clone();
                    let app_handle = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        bridge.shutdown().await;
                        app_handle.exit(0);
                    });
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
            let emitter = Arc::new(TauriMainWindowEmitter::new(app.handle().clone()));
            tauri::async_runtime::spawn(async move {
                bridge.retry(emitter).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell_snapshot,
            shell_retry,
            shell_start,
            shell_stop,
            shell_restart
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
