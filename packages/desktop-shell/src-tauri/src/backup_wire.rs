use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The native shell validates only the allowlisted backup wire shape. Backup
/// selection, confirmation, file access and publication remain owned by the
/// TypeScript Backup Authority.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum BackupCommand {
    Create { command: Value },
    Confirm { action_id: String },
}

impl BackupCommand {
    pub(crate) fn create(command: Value) -> Option<Self> {
        let decoded: BackupCreateCommandWire = serde_json::from_value(command).ok()?;
        if !decoded.is_valid() {
            return None;
        }
        Some(Self::Create {
            command: serde_json::to_value(decoded).ok()?,
        })
    }

    pub(crate) fn confirm(action_id: String) -> Option<Self> {
        (!action_id.is_empty() && action_id.len() <= 128).then_some(Self::Confirm { action_id })
    }

    pub(crate) fn request_id(&self) -> &'static str {
        match self {
            Self::Create { .. } => "desktop-backup-create",
            Self::Confirm { .. } => "desktop-backup-confirm",
        }
    }

    pub(crate) fn request(&self) -> Value {
        let command = match self {
            Self::Create { command } => json!({
                "command": "create",
                "mode": command["mode"],
                "destinationPath": command["destinationPath"],
                "overwrite": command["overwrite"],
            }),
            Self::Confirm { action_id } => json!({
                "command": "confirm",
                "actionId": action_id,
            }),
        };
        json!({
            "type": "backup_command",
            "requestId": self.request_id(),
            "command": command,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BackupCreateCommandWire {
    mode: String,
    #[serde(rename = "destinationPath")]
    destination_path: String,
    overwrite: bool,
}

impl BackupCreateCommandWire {
    fn is_valid(&self) -> bool {
        matches!(self.mode.as_str(), "ordinary" | "full_sensitive")
            && !self.destination_path.is_empty()
            && self.destination_path.len() <= 4_096
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub(crate) struct BackupResultWire {
    pub(crate) outcome: String,
    #[serde(rename = "actionId", skip_serializing_if = "Option::is_none")]
    pub(crate) action_id: Option<String>,
    #[serde(
        rename = "confirmationMessage",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) confirmation_message: Option<String>,
    #[serde(rename = "destinationPath", skip_serializing_if = "Option::is_none")]
    pub(crate) destination_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) manifest: Option<BackupManifestWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) failure: Option<BackupFailureWire>,
}

impl BackupResultWire {
    pub(crate) fn is_valid(&self) -> bool {
        let nonempty =
            |value: &Option<String>| value.as_ref().is_some_and(|value| !value.is_empty());
        match self.outcome.as_str() {
            "ok" => {
                nonempty(&self.destination_path)
                    && self
                        .manifest
                        .as_ref()
                        .is_some_and(BackupManifestWire::is_valid)
                    && self.action_id.is_none()
                    && self.confirmation_message.is_none()
                    && self.failure.is_none()
            }
            "confirmation_required" => {
                nonempty(&self.action_id)
                    && nonempty(&self.confirmation_message)
                    && self.destination_path.is_none()
                    && self.manifest.is_none()
                    && self.failure.is_none()
            }
            "failed" => {
                self.failure
                    .as_ref()
                    .is_some_and(BackupFailureWire::is_valid)
                    && self.action_id.is_none()
                    && self.confirmation_message.is_none()
                    && self.destination_path.is_none()
                    && self.manifest.is_none()
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub(crate) struct BackupManifestWire {
    format: String,
    #[serde(rename = "formatVersion")]
    format_version: u64,
    #[serde(rename = "createdAt")]
    created_at: u64,
    sensitive: bool,
    entries: Vec<BackupManifestEntryWire>,
}

impl BackupManifestWire {
    fn is_valid(&self) -> bool {
        self.format == "luckytoken-backup"
            && self.format_version == 1
            && self.created_at <= MAX_SAFE_INTEGER
            && self
                .entries
                .iter()
                .all(|entry| entry.is_valid() && entry.sensitive == self.sensitive)
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
struct BackupManifestEntryWire {
    id: String,
    contract: String,
    version: Value,
    sensitive: bool,
}

impl BackupManifestEntryWire {
    fn is_valid(&self) -> bool {
        !self.id.is_empty()
            && self.id.len() <= 128
            && !self.contract.is_empty()
            && self.contract.len() <= 128
            && valid_version(&self.version)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct BackupFailureWire {
    code: String,
    message: String,
}

impl BackupFailureWire {
    fn is_valid(&self) -> bool {
        matches!(
            self.code.as_str(),
            "invalid_destination"
                | "destination_exists"
                | "destination_locked"
                | "source_outside_owned_root"
                | "source_unavailable"
                | "backup_too_large"
                | "cancelled"
                | "internal"
        ) && !self.message.is_empty()
            && self.message.len() <= 512
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct RecoveryProjectionWire {
    mode: String,
    issues: Vec<CompatibilityIssueWire>,
}

impl RecoveryProjectionWire {
    pub(crate) fn is_valid(&self) -> bool {
        self.mode == "incompatible_configuration"
            && !self.issues.is_empty()
            && self.issues.len() <= 64
            && self.issues.iter().all(CompatibilityIssueWire::is_valid)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
struct CompatibilityIssueWire {
    path: String,
    contract: String,
    #[serde(rename = "foundVersion")]
    found_version: Value,
    #[serde(rename = "expectedVersion")]
    expected_version: Value,
    #[serde(rename = "validationError")]
    validation_error: String,
}

impl CompatibilityIssueWire {
    fn is_valid(&self) -> bool {
        !self.path.is_empty()
            && self.path.len() <= 4_096
            && !self.contract.is_empty()
            && self.contract.len() <= 128
            && valid_version(&self.found_version)
            && valid_version(&self.expected_version)
            && !self.validation_error.is_empty()
            && self.validation_error.len() <= 512
    }
}

fn valid_version(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| !value.is_empty() && value.len() <= 128)
        || value
            .as_u64()
            .is_some_and(|value| value <= MAX_SAFE_INTEGER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_commands_reject_unallowlisted_shapes() {
        assert!(BackupCommand::create(json!({
            "mode": "ordinary",
            "destinationPath": "C:\\backup.json",
            "overwrite": false,
        }))
        .is_some());
        assert!(BackupCommand::create(json!({
            "mode": "ordinary",
            "destinationPath": "C:\\backup.json",
            "overwrite": false,
            "secret": "must-not-pass",
        }))
        .is_none());
    }

    #[test]
    fn recovery_projection_requires_a_nonempty_valid_issue_list() {
        let valid: RecoveryProjectionWire = serde_json::from_value(json!({
            "mode": "incompatible_configuration",
            "issues": [{
                "path": "C:\\config.json",
                "contract": "luckytoken-config",
                "foundVersion": 2,
                "expectedVersion": 1,
                "validationError": "Unsupported version."
            }]
        }))
        .expect("valid projection");
        assert!(valid.is_valid());
    }
}
