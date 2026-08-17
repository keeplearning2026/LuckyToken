use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use serde::Deserialize;

/// Ticket 26 desktop-owned backend launcher. When no Control Plane exists,
/// the thin Rust shell starts the bundled Node backend exactly once and
/// then retries discovery. All domain behavior (first-run config creation,
/// ownership, protocol conversion) stays in the TypeScript backend; Rust
/// only resolves the installed layout and spawns the process.

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LauncherConfig {
    pub(crate) backend_node_executable: PathBuf,
    pub(crate) backend_cli_script: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LauncherDescriptor {
    #[serde(rename = "backendNodeExecutable")]
    backend_node_executable: String,
    #[serde(rename = "backendCliScript")]
    backend_cli_script: String,
}

impl LauncherConfig {
    fn parse(value: &[u8], base: &Path) -> Result<Self, LauncherFailure> {
        let descriptor = serde_json::from_slice::<LauncherDescriptor>(value)
            .map_err(|_| LauncherFailure::Invalid)?;
        if descriptor.backend_node_executable.trim().is_empty()
            || descriptor.backend_cli_script.trim().is_empty()
        {
            return Err(LauncherFailure::Invalid);
        }
        Ok(Self {
            backend_node_executable: resolve_against(
                base,
                PathBuf::from(descriptor.backend_node_executable),
            ),
            backend_cli_script: resolve_against(base, PathBuf::from(descriptor.backend_cli_script)),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LauncherFailure {
    Invalid,
}

fn resolve_against(base: &Path, value: PathBuf) -> PathBuf {
    if value.is_absolute() {
        value
    } else {
        base.join(value)
    }
}

pub(crate) struct BackendLauncher {
    config: Option<LauncherConfig>,
    exe_dir: PathBuf,
    home_dir: PathBuf,
    spawned: AtomicBool,
}

impl BackendLauncher {
    pub(crate) fn from_paths(
        launcher_path: Option<PathBuf>,
        exe_dir: PathBuf,
        home_dir: PathBuf,
    ) -> Self {
        let config = launcher_path.and_then(|path| {
            let base = path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| exe_dir.clone());
            std::fs::read(&path)
                .ok()
                .and_then(|bytes| LauncherConfig::parse(&bytes, &base).ok())
        });
        Self {
            config,
            exe_dir,
            home_dir,
            spawned: AtomicBool::new(false),
        }
    }

    pub(crate) fn available(&self) -> bool {
        self.config.is_some()
    }

    /// Spawns the bundled backend at most once per connector instance.
    /// Returns true when a backend was (or had already been) requested.
    pub(crate) fn spawn_once(&self) -> bool {
        if self.spawned.swap(true, Ordering::SeqCst) {
            return true;
        }
        let Some(config) = self.config.as_ref() else {
            return false;
        };
        let current_exe = std::env::current_exe().unwrap_or_else(|_| self.exe_dir.clone());
        match build_backend_command(config, &current_exe, &self.home_dir) {
            Ok(mut command) => {
                if command.spawn().is_err() {
                    // A failed spawn resets the gate so a later connect can
                    // retry once the installed layout is repaired.
                    self.spawned.store(false, Ordering::SeqCst);
                    return false;
                }
                true
            }
            Err(()) => {
                self.spawned.store(false, Ordering::SeqCst);
                false
            }
        }
    }
}

pub(crate) fn build_backend_command(
    config: &LauncherConfig,
    current_exe: &Path,
    home_dir: &Path,
) -> Result<std::process::Command, ()> {
    let config_path = home_dir.join(".luckytoken").join("config.json");
    let mut command = std::process::Command::new(&config.backend_node_executable);
    command
        .arg(&config.backend_cli_script)
        .arg("serve")
        .arg("--config")
        .arg(&config_path)
        .arg("--owner")
        .arg("desktop")
        .arg("--desktop-exe")
        .arg(current_exe)
        .arg("--create-first-run-config");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000): the backend is a console process
        // that must never flash a window when the desktop launches it.
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

pub(crate) fn resolve_launcher_override(args: &[OsString]) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == "--launcher")
        .map(|pair| PathBuf::from(&pair[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn config_with(launcher_json: &str, base: &Path) -> Result<LauncherConfig, LauncherFailure> {
        LauncherConfig::parse(launcher_json.as_bytes(), base)
    }

    #[test]
    fn launcher_descriptor_parses_and_resolves_relative_paths() {
        let base = Path::new(r"C:\Program Files\LuckyToken");
        let config = config_with(
            r#"{"backendNodeExecutable":"backend\\node\\node.exe","backendCliScript":"backend\\dist\\cli.js"}"#,
            base,
        )
        .expect("valid launcher descriptor");
        assert_eq!(
            config.backend_node_executable,
            Path::new(r"C:\Program Files\LuckyToken\backend\node\node.exe")
        );
        assert_eq!(
            config.backend_cli_script,
            Path::new(r"C:\Program Files\LuckyToken\backend\dist\cli.js")
        );
    }

    #[test]
    fn launcher_descriptor_rejects_malformed_and_foreign_shapes() {
        let base = Path::new(r"C:\app");
        for invalid in [
            "",
            "not-json",
            "{}",
            r#"{"backendNodeExecutable":"a"}"#,
            r#"{"backendCliScript":"b"}"#,
            r#"{"backendNodeExecutable":"a","backendCliScript":"b","foreign":"x"}"#,
            r#"{"backendNodeExecutable":"","backendCliScript":"b"}"#,
            r#"{"backendNodeExecutable":"a","backendCliScript":""}"#,
        ] {
            assert_eq!(
                config_with(invalid, base),
                Err(LauncherFailure::Invalid),
                "must reject {invalid}"
            );
        }
    }

    #[test]
    fn launcher_override_resolves_exactly_like_descriptor_override() {
        let args = [
            OsString::from("LuckyToken.exe"),
            OsString::from("--launcher"),
            OsString::from(r"D:\test\launcher.json"),
        ];
        assert_eq!(
            resolve_launcher_override(&args),
            Some(PathBuf::from(r"D:\test\launcher.json"))
        );
        assert_eq!(resolve_launcher_override(&args[..1]), None);
    }

    #[test]
    fn backend_command_uses_the_desktop_owner_contract() {
        let config = LauncherConfig {
            backend_node_executable: PathBuf::from(r"C:\app\backend\node\node.exe"),
            backend_cli_script: PathBuf::from(r"C:\app\backend\dist\cli.js"),
        };
        let command = build_backend_command(
            &config,
            Path::new(r"C:\app\LuckyToken.exe"),
            Path::new(r"C:\Users\Alice"),
        )
        .expect("command assembly");
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        assert_eq!(
            args,
            [
                std::ffi::OsStr::new(r"C:\app\backend\dist\cli.js"),
                std::ffi::OsStr::new("serve"),
                std::ffi::OsStr::new("--config"),
                std::ffi::OsStr::new(r"C:\Users\Alice\.luckytoken\config.json"),
                std::ffi::OsStr::new("--owner"),
                std::ffi::OsStr::new("desktop"),
                std::ffi::OsStr::new("--desktop-exe"),
                std::ffi::OsStr::new(r"C:\app\LuckyToken.exe"),
                std::ffi::OsStr::new("--create-first-run-config"),
            ]
        );
    }
}
