//! Revalidate and project optional private provenance at the native IPC boundary.
use super::*;

const MAX_INTEGER: u64 = 9_007_199_254_740_991;
pub(super) const TEXT_LIMIT: usize = 8 * 1024;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Coverage {
    retention: String,
    limit_bytes: u64,
    bytes_seen: u64,
    bytes_retained: u64,
    bytes_dropped: u64,
    truncated: bool,
    stream_complete: bool,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CommandRecord {
    command_id: String,
    stage_id: String,
    substage_id: String,
    sequence: u64,
    completed_steps: u8,
    started_at: u64,
    finished_at: Option<u64>,
    outcome: String,
    exit_code: Option<i32>,
    output: Coverage,
}
#[derive(Deserialize, Serialize)]
struct Logs {
    #[serde(rename = "command.log")]
    command: Option<u64>,
    #[serde(rename = "failed-command.log")]
    failed: Option<u64>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    schema: u8,
    operation_id: String,
    environment_id: String,
    release_id: String,
    started_at: u64,
    updated_at: u64,
    command_count: u64,
    omitted_command_count: u64,
    commands: Vec<CommandRecord>,
    failed_command: Option<CommandRecord>,
    logs: Logs,
}
fn stage(command: &str) -> Option<&'static str> {
    match command {
        "accounts.workspace-group"
        | "accounts.create-outpost-coord"
        | "accounts.create-outpost-pi"
        | "accounts.create-outpost-build"
        | "accounts.workspace-outpost-coord"
        | "accounts.workspace-outpost-pi" => Some("service-accounts"),
        "dependencies.build-ownership"
        | "dependencies.npm-ci"
        | "dependencies.typescript-version" => Some("server-dependencies"),
        "browser.system-dependencies" | "browser.python-sync" | "browser.validate-launcher" => {
            Some("browser-runtime")
        }
        "configuration.release-ownership" | "configuration.release-permissions" => {
            Some("protected-configuration")
        }
        "enrollment.initialize" => Some("device-enrollment"),
        "services.verify-units" | "services.daemon-reload" | "services.enable" => {
            Some("persistent-services")
        }
        "health.services-active" => Some("health-verification"),
        _ => None,
    }
}
impl CommandRecord {
    fn valid(&self) -> bool {
        let coverage = &self.output;
        stage(&self.command_id) == Some(self.stage_id.as_str())
            && self
                .command_id
                .split_once('.')
                .is_some_and(|(_, substage)| substage == self.substage_id)
            && self.sequence > 0
            && self.sequence <= MAX_INTEGER
            && self.completed_steps <= 10
            && self.started_at <= MAX_INTEGER
            && self
                .finished_at
                .is_none_or(|time| (self.started_at..=MAX_INTEGER).contains(&time))
            && (self.outcome == "running") == self.finished_at.is_none()
            && matches!(
                self.outcome.as_str(),
                "running"
                    | "succeeded"
                    | "failed"
                    | "timed_out"
                    | "cancelled"
                    | "start_failed"
                    | "capture_failed"
            )
            && self
                .exit_code
                .is_none_or(|code| (-255..=255).contains(&code))
            && coverage.retention == "tail"
            && (1..=256 * 1024).contains(&coverage.limit_bytes)
            && coverage.bytes_seen <= MAX_INTEGER
            && coverage.bytes_retained <= coverage.limit_bytes
            && coverage.bytes_retained <= coverage.bytes_seen
            && coverage.bytes_dropped == coverage.bytes_seen.saturating_sub(coverage.bytes_retained)
            && coverage.truncated == (coverage.bytes_dropped > 0 || !coverage.stream_complete)
    }
}
pub(super) struct Projection {
    pub text: String,
    pub redacted: bool,
    pub truncated: bool,
    pub has_failure: bool,
    pub failure_truncated: bool,
}
pub(super) fn project(input: &str, binding: &Binding) -> Result<Projection, ()> {
    if input.len() > 32 * 1024 {
        return Err(());
    }
    let raw: Value = serde_json::from_str(input).map_err(|_| ())?;
    // Unknown fields (notably argv, labels, environment and arbitrary log paths)
    // are ignored on deserialization and cannot be reserialized into a report.
    let mut sidecar: Sidecar = serde_json::from_value(raw.clone()).map_err(|_| ())?;
    if sidecar.schema != 1
        || sidecar.operation_id != binding.operation
        || sidecar.environment_id != binding.environment
        || sidecar.release_id != binding.release
        || sidecar.started_at > MAX_INTEGER
        || sidecar.updated_at > MAX_INTEGER
        || sidecar.command_count > MAX_INTEGER
        || sidecar.commands.len() > 32
        || sidecar
            .omitted_command_count
            .checked_add(sidecar.commands.len() as u64)
            != Some(sidecar.command_count)
        || sidecar.logs.command != (sidecar.command_count > 0).then_some(sidecar.command_count)
        || sidecar.logs.failed
            != sidecar
                .failed_command
                .as_ref()
                .map(|record| record.sequence)
        || sidecar.commands.iter().enumerate().any(|(index, record)| {
            !record.valid() || record.sequence != sidecar.omitted_command_count + index as u64 + 1
        })
        || sidecar.failed_command.as_ref().is_some_and(|failed| {
            !failed.valid()
                || failed.sequence > sidecar.command_count
                || matches!(failed.outcome.as_str(), "running" | "succeeded")
                || sidecar
                    .commands
                    .iter()
                    .any(|record| record.sequence == failed.sequence && record != failed)
        })
    {
        return Err(());
    }
    let redacted = serde_json::to_value(&sidecar).map_err(|_| ())? != raw;
    let original_count = sidecar.commands.len();
    while sidecar.commands.len() > 8 {
        sidecar.commands.remove(0);
    }
    loop {
        sidecar.omitted_command_count = sidecar.command_count - sidecar.commands.len() as u64;
        let text = serde_json::to_string(&sidecar).map_err(|_| ())?;
        if text.len() <= TEXT_LIMIT {
            return Ok(Projection {
                text,
                redacted,
                truncated: sidecar.commands.len() < original_count,
                has_failure: sidecar.failed_command.is_some(),
                failure_truncated: sidecar
                    .failed_command
                    .as_ref()
                    .is_some_and(|record| record.output.truncated),
            });
        }
        if sidecar.commands.is_empty() {
            return Err(());
        }
        sidecar.commands.remove(0);
    }
}
