use std::{ffi::OsString, path::PathBuf};

use serde::Deserialize;
use tauri::Manager;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiscoveryFailure {
    Missing,
    Invalid,
}

#[derive(Clone)]
pub(crate) struct NativeControlPlaneDiscovery {
    descriptor_path: Result<PathBuf, DiscoveryFailure>,
}

pub(crate) struct ControlPlaneAuthority {
    pipe_name: String,
    capability: String,
}

impl ControlPlaneAuthority {
    pub(crate) fn into_parts(self) -> (String, String) {
        (self.pipe_name, self.capability)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlPlaneDescriptor {
    #[serde(rename = "pipeName")]
    pipe_name: String,
    capability: String,
}

impl NativeControlPlaneDiscovery {
    pub(crate) fn from_app(app: &tauri::AppHandle) -> Self {
        let args = std::env::args_os().collect::<Vec<_>>();
        let descriptor_path = resolve_descriptor_override(&args).map_or_else(
            || {
                app.path()
                    .home_dir()
                    .map(|home| home.join(".luckytoken").join("control-plane.json"))
                    .map_err(|_| DiscoveryFailure::Missing)
            },
            Ok,
        );
        Self { descriptor_path }
    }

    pub(crate) async fn discover(&self) -> Result<ControlPlaneAuthority, DiscoveryFailure> {
        let path = self.descriptor_path.as_ref().map_err(|failure| *failure)?;
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(DiscoveryFailure::Missing);
            }
            Err(_) => return Err(DiscoveryFailure::Invalid),
        };
        let descriptor = serde_json::from_slice::<ControlPlaneDescriptor>(&bytes)
            .map_err(|_| DiscoveryFailure::Invalid)?;
        if !descriptor.pipe_name.starts_with(r"\\.\pipe\") || descriptor.capability.len() < 32 {
            return Err(DiscoveryFailure::Invalid);
        }
        Ok(ControlPlaneAuthority {
            pipe_name: descriptor.pipe_name,
            capability: descriptor.capability,
        })
    }
}

fn resolve_descriptor_override(args: &[OsString]) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == "--descriptor")
        .map(|pair| PathBuf::from(&pair[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn descriptor_location_defaults_to_one_current_user_authority() {
        let home = Path::new(r"C:\Users\Alice");
        let args = [OsString::from("LuckyToken.exe")];
        assert_eq!(
            resolve_descriptor_override(&args)
                .unwrap_or_else(|| home.join(".luckytoken").join("control-plane.json")),
            home.join(".luckytoken").join("control-plane.json")
        );

        let override_args = [
            OsString::from("LuckyToken.exe"),
            OsString::from("--descriptor"),
            OsString::from(r"D:\test\control-plane.json"),
        ];
        assert_eq!(
            resolve_descriptor_override(&override_args),
            Some(PathBuf::from(r"D:\test\control-plane.json"))
        );
    }
}
