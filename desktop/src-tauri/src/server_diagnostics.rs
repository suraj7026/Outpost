//! Isolated, bounded, read-only diagnostics. No renderer-supplied paths or commands.
use super::*;
use history::ActivityKind;
use tauri::Manager;

#[path = "server_diagnostic_guide.rs"]
mod guide;
#[path = "server_diagnostic_sidecar.rs"]
mod sidecar;
#[path = "server_diagnostic_text.rs"]
mod text;
const COLLECTOR: &str = include_str!("setup_diagnostic_collector.py");
const MAX_REPLY: usize = 48 * 1024;
const CACHE_TTL: u64 = 5 * 60 * 1000;
const CACHE_COUNT: usize = 8;
const COLLECTION_ERROR: &str = "Diagnostic read unavailable. Check the pinned SSH host, unlocked key/agent and diagnostic sudo permission. No installation was started or stopped; manual troubleshooting remains available.";
const CANCELLED: &str =
    "Diagnostic authorization or collection cancelled. Installation was not cancelled.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    Available,
    Missing,
    PermissionDenied,
    Unsafe,
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticSource {
    id: String,
    label: String,
    status: SourceStatus,
    text: String,
    truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticReport {
    schema_version: u8,
    report_id: String,
    setup_id: String,
    operation_id: String,
    environment_id: String,
    release_id: String,
    stage: String,
    state: String,
    completed_steps: u8,
    total_steps: u8,
    collected_at: u64,
    expires_at: u64,
    sources: Vec<DiagnosticSource>,
    notes: Vec<String>,
    redacted: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSource {
    id: String,
    status: SourceStatus,
    text: String,
    truncated: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireReport {
    schema_version: u8,
    operation_id: String,
    environment_id: String,
    release_id: String,
    stage: String,
    state: String,
    completed_steps: u8,
    total_steps: u8,
    updated_at: u64,
    sources: Vec<WireSource>,
}
#[derive(Clone, PartialEq)]
struct Binding {
    setup: String,
    target: Target,
    fingerprint: String,
    plan: String,
    operation: String,
    environment: String,
    release: String,
}
impl Binding {
    fn from_entry(entry: &Entry) -> Result<Self, String> {
        environments::validate_id(&entry.id)?;
        entry.target.validate()?;
        let plan = entry
            .plan
            .as_ref()
            .ok_or("No saved installation plan is available for diagnostics")?;
        plan.validate()?;
        let progress = entry
            .installation
            .as_ref()
            .ok_or("No saved installation receipt is available for diagnostics")?;
        if progress.operation_id != plan.operation_id
            || progress.environment_id != plan.environment_id
            || progress.release_id != plan.release_id
        {
            return Err("Saved diagnostic operation identity does not match its plan".into());
        }
        Ok(Self {
            setup: entry.id.clone(),
            target: entry.target.clone(),
            fingerprint: entry.fingerprint.clone(),
            plan: plan.plan_id.clone(),
            operation: plan.operation_id.clone(),
            environment: plan.environment_id.clone(),
            release: plan.release_id.clone(),
        })
    }
}
struct DiagnosticRequest {
    guard: history::ActivityGuard,
    binding: Binding,
    protected: bool,
    password: bool,
}
pub(super) struct CachedReport {
    binding: Binding,
    report: DiagnosticReport,
    remote_updated_at: u64,
    cached_at: Instant,
}
impl CachedReport {
    fn valid(&self, entry: &Entry) -> bool {
        self.report.expires_at > now()
            && self.cached_at.elapsed() < Duration::from_millis(CACHE_TTL)
            && Binding::from_entry(entry).is_ok_and(|binding| binding == self.binding)
            && not_stale(entry, self.remote_updated_at, self.report.completed_steps)
    }
}
fn not_stale(entry: &Entry, timestamp: u64, steps: u8) -> bool {
    entry.installation.as_ref().is_some_and(|p| {
        p.remote_timestamp()
            .is_none_or(|current| timestamp >= current)
            && steps
                >= if p.state == "complete" {
                    10
                } else {
                    p.completed_steps
                }
    })
}
pub(super) fn invalidate(inner: &mut Inner, id: &str) {
    if let Some(activity) = inner
        .activities
        .get(id)
        .filter(|v| v.kind == ActivityKind::Diagnostics)
    {
        activity.cancel.store(true, Ordering::SeqCst);
    }
    inner.diagnostic_cache.retain(|v| v.binding.setup != id);
}
fn label(id: &str) -> Option<(&'static str, usize)> {
    match id {
        "status.json" => Some(("Installation receipt", 4096)),
        "launch.json" => Some(("Service launch receipt", 1024)),
        "command.log" => Some(("Latest installer command output (legacy)", 12288)),
        "failed-command.log" => Some(("Preserved failed-command output", 12288)),
        "diagnostics.json" => Some(("Validated command provenance", sidecar::TEXT_LIMIT)),
        "launch.log" => Some(("Installer launch output", 4096)),
        "service" => Some(("Setup service properties", 4096)),
        _ => None,
    }
}
fn is_log_source(id: &str) -> bool {
    matches!(id, "command.log" | "failed-command.log" | "launch.log")
}
fn report_from_wire(
    bytes: &[u8],
    entry: &Entry,
    binding: &Binding,
    protected: bool,
    report_id: String,
) -> Result<(DiagnosticReport, u64), String> {
    if bytes.len() > MAX_REPLY {
        return Err("Diagnostic reply exceeded its encoded budget".into());
    }
    let mut wire: WireReport =
        serde_json::from_slice(bytes).map_err(|_| "Malformed or unsupported diagnostic reply")?;
    if wire.schema_version != 1
        || wire.operation_id != binding.operation
        || wire.environment_id != binding.environment
        || wire.release_id != binding.release
        || wire.total_steps != 12
        || wire.completed_steps > 10
        || wire.stage.len() > 100
        || !(5..=7).contains(&wire.sources.len())
        || wire.updated_at > 9_007_199_254_740_991
        || !matches!(
            wire.state.as_str(),
            "queued" | "running" | "unknown" | "ready" | "failed" | "cancelled" | "interrupted"
        )
        || wire.state == "ready" && wire.completed_steps != 10
        || !not_stale(entry, wire.updated_at, wire.completed_steps)
    {
        return Err(
            "Stale or foreign diagnostic operation receipt; check progress and collect again"
                .into(),
        );
    }
    let stage = text::sanitize(&wire.stage);
    let mut redacted = stage != wire.stage;
    let mut has_failure = false;
    let mut failure_truncated = false;
    let mut unsafe_sidecar = false;
    for source in wire
        .sources
        .iter_mut()
        .filter(|source| source.id == "diagnostics.json")
    {
        if !protected {
            continue;
        }
        unsafe_sidecar |= source.status == SourceStatus::Unsafe;
        if source.status == SourceStatus::Available {
            match sidecar::project(&source.text, binding) {
                Ok(projection) => {
                    has_failure = projection.has_failure;
                    failure_truncated = projection.failure_truncated;
                    source.text = projection.text;
                    source.truncated |= projection.truncated;
                    redacted |= projection.redacted;
                }
                Err(()) => {
                    unsafe_sidecar = true;
                    source.status = SourceStatus::Unsafe;
                    source.text.clear();
                }
            }
        } else {
            // Sidecar failure details are fixed statuses, not arbitrary remote metadata.
            source.text.clear();
        }
    }
    if unsafe_sidecar {
        for source in wire
            .sources
            .iter_mut()
            .filter(|source| source.id == "failed-command.log")
        {
            source.status = SourceStatus::Unsafe;
            source.text.clear();
        }
    }
    let preserved = protected
        && wire.sources.iter().any(|source| {
            source.id == "failed-command.log" && source.status == SourceStatus::Available
        });
    if preserved {
        for source in wire
            .sources
            .iter_mut()
            .filter(|source| source.id == "command.log")
        {
            source.status = SourceStatus::Unavailable;
            source.text = "Not collected: preserved failed-command.log was preferred within the command-output budget.".into();
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut sources = Vec::new();
    for source in wire.sources {
        let (label, limit) = label(&source.id).ok_or("Unsupported diagnostic source")?;
        if !seen.insert(source.id.clone()) {
            return Err("Duplicate diagnostic source".into());
        }
        let private = matches!(
            source.id.as_str(),
            "command.log" | "launch.log" | "diagnostics.json" | "failed-command.log"
        );
        if private && !protected {
            // Do not trust the remote peer to honor a declined private-read choice.
            sources.push(DiagnosticSource {
                id: source.id,
                label: label.into(),
                status: SourceStatus::PermissionDenied,
                text: String::new(),
                truncated: false,
            });
            continue;
        }
        // Sidecar text is already projected to typed, fixed-vocabulary fields. Keep
        // its JSON intact; free-form log text takes the conservative redaction path.
        let mut raw = source.text;
        let raw_truncated = is_log_source(&source.id) && text::truncate_tail(&mut raw, limit);
        let mut sanitized = if source.id == "diagnostics.json" {
            raw.clone()
        } else {
            text::sanitize(&raw)
        };
        redacted |= sanitized != raw;
        let shortened = if is_log_source(&source.id) {
            text::truncate_tail(&mut sanitized, limit)
        } else {
            text::truncate(&mut sanitized, limit)
        };
        let truncated = raw_truncated
            || shortened
            || source.truncated
            || source.id == "failed-command.log" && failure_truncated;
        sources.push(DiagnosticSource {
            id: source.id,
            label: label.into(),
            status: source.status,
            text: sanitized,
            truncated,
        });
    }
    if [
        "status.json",
        "launch.json",
        "command.log",
        "launch.log",
        "service",
    ]
    .iter()
    .any(|id| !seen.contains(*id))
    {
        return Err("Missing required diagnostic source".into());
    }
    sources.sort_by_key(|source| match source.id.as_str() {
        "status.json" => 0,
        "diagnostics.json" => 1,
        "failed-command.log" => 2,
        "command.log" => 3,
        "launch.json" => 4,
        "launch.log" => 5,
        _ => 6,
    });
    let collected_at = now();
    let mut report = DiagnosticReport {
        schema_version: 1, report_id, setup_id: binding.setup.clone(), operation_id: binding.operation.clone(), environment_id: binding.environment.clone(), release_id: binding.release.clone(), stage, state: wire.state, completed_steps: wire.completed_steps, total_steps: wire.total_steps,
        collected_at, expires_at: collected_at + CACHE_TTL, sources,
        notes: vec![
            "Review before sharing. Redaction is best effort; no report is uploaded automatically.".into(),

            "Service properties do not override a failed installation receipt. Evidence can change during collection.".into(),
            "Collection reads selected excerpts only. SSH/sudo may create normal audit records; no installation files or configuration are changed.".into(),
        ], redacted,
    };
    report.notes.push(if has_failure {
        if preserved {
            "Preserved failed-command.log is preferred over latest command.log. Validated diagnostics.json identifies the recorded failed command, outcome and output coverage; arbitrary command lines and labels are excluded."
        } else {
            "Validated diagnostics.json identifies the recorded failed command and outcome, but its preserved output was not available. Latest command.log, if present, is not guaranteed to be that command's output."
        }
    } else if preserved {
        "Preserved failed-command.log is preferred over latest command.log. No validated failed-command attribution is available; the filename alone does not prove which command failed."
    } else {
        "Legacy command.log is latest-command output, not guaranteed failed-command output or full history. Exact failed-command attribution is unavailable without a validated diagnostic sidecar."
    }.into());
    if !protected {
        report.notes.push("Private logs were not requested and were not read, including for root SSH sessions. Use Read protected logs for separate diagnostic authorization.".into());
    }
    fit_report_budget(&mut report)?;
    Ok((report, wire.updated_at))
}
fn fit_report_budget(report: &mut DiagnosticReport) -> Result<(), String> {
    while serde_json::to_vec(report)
        .map_err(|_| "Cannot encode diagnostics")?
        .len()
        > MAX_REPLY
    {
        let largest = report
            .sources
            .iter_mut()
            .filter(|source| {
                !matches!(
                    source.id.as_str(),
                    "status.json" | "launch.json" | "diagnostics.json"
                )
            })
            .max_by_key(|source| source.text.len())
            .ok_or("Diagnostic reply budget exceeded")?;
        if largest.text.is_empty() {
            return Err("Diagnostic reply budget exceeded".into());
        }
        let limit = largest.text.len() / 2;
        if is_log_source(&largest.id) {
            text::truncate_tail(&mut largest.text, limit);
        } else {
            text::truncate(&mut largest.text, limit);
        }
        largest.truncated = true;
    }
    Ok(())
}
fn collector_command() -> String {
    format!(
        "/usr/bin/python3 -I -B -S -c 'import base64;exec(base64.b64decode(\"{}\"))'",
        STANDARD.encode(COLLECTOR)
    )
}
fn authorize(
    entry: &Entry,
    password: bool,
    cancel: &AtomicBool,
) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    let prompt = serde_json::to_string(&format!("Read protected diagnostic logs for {}@{}:{} only. This transfers bounded installer log excerpts to this Mac; it does not install, repair, restart or stop anything. {}", entry.target.user, entry.target.host, entry.target.port,
        if password { "Enter the server sudo password. It is not saved or sent to the app page." } else { "Allow this read using the saved SSH account's administrator access?" }))
        .map_err(|_| "Invalid diagnostic authorization target")?;
    let field = if password {
        " default answer \"\" with hidden answer"
    } else {
        ""
    };
    let prefix = if password {
        "text returned of "
    } else {
        "button returned of "
    };
    let script = format!("{prefix}(display dialog {prompt}{field} buttons {{\"Cancel\", \"Read protected logs\"}} default button \"Read protected logs\" with title \"Outpost diagnostic read\")");
    let mut secret = zeroize::Zeroizing::new(
        run_bounded(
            "/usr/bin/osascript",
            &["-e".into(), script],
            b"",
            Duration::from_secs(180),
            cancel,
            1024,
        )
        .map_err(|_| CANCELLED)?,
    );
    if cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    if !password {
        if secret.as_slice() != b"Read protected logs\n" {
            return Err(CANCELLED.into());
        }
        secret.clear();
        return Ok(secret);
    }
    while matches!(secret.last(), Some(b'\n' | b'\r')) {
        secret.pop();
    }
    if secret.is_empty() || secret.iter().any(|byte| *byte < 32 || *byte == 127) {
        return Err("Invalid diagnostic authorization input".into());
    }
    secret.push(b'\n');
    Ok(secret)
}
impl Setup {
    fn reserve_diagnostics(
        &self,
        id: &str,
        protected: bool,
        password: bool,
    ) -> Result<DiagnosticRequest, String> {
        if password && !protected {
            return Err("Password authorization requires explicit protected-log consent".into());
        }
        let guard = self.activity(id, ActivityKind::Diagnostics)?;
        let binding = Binding::from_entry(&guard.entry)?;
        {
            let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            inner.diagnostic_cache.retain(|v| {
                v.binding.setup != id
                    && v.report.expires_at > now()
                    && v.cached_at.elapsed() < Duration::from_millis(CACHE_TTL)
            });
        }
        Ok(DiagnosticRequest {
            guard,
            binding,
            protected,
            password,
        })
    }
    #[cfg(test)]
    fn collect_diagnostics_with(
        &self,
        id: &str,
        protected: bool,
        password: bool,
        auth: impl FnOnce(&Entry, bool, &AtomicBool) -> Result<zeroize::Zeroizing<Vec<u8>>, String>,
    ) -> Result<DiagnosticReport, String> {
        let request = self.reserve_diagnostics(id, protected, password)?;
        self.collect_reserved_diagnostics_with(request, auth)
    }
    fn collect_reserved_diagnostics_with(
        &self,
        request: DiagnosticRequest,
        auth: impl FnOnce(&Entry, bool, &AtomicBool) -> Result<zeroize::Zeroizing<Vec<u8>>, String>,
    ) -> Result<DiagnosticReport, String> {
        let DiagnosticRequest {
            guard,
            binding,
            protected,
            password,
        } = request;
        let id = guard.entry.id.as_str();
        if guard.cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        self.ready().map_err(|_| CANCELLED)?;
        if Binding::from_entry(&self.entry(id)?)? != binding {
            return Err("Diagnostic target changed before collection started".into());
        }
        // Validate the pinned transport before presenting a native authorization dialog.
        self.ssh_args(&guard.entry).map_err(|_| COLLECTION_ERROR)?;
        if guard.cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        let root = guard.entry.inspection.as_ref().is_some_and(|v| v.uid == 0);
        let mut input = if protected {
            auth(&guard.entry, password && !root, &guard.cancel).map_err(|_| CANCELLED)?
        } else {
            zeroize::Zeroizing::new(Vec::new())
        };
        if guard.cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        if Binding::from_entry(&self.entry(id)?)? != binding {
            return Err("Diagnostic target changed during authorization".into());
        }
        // A native dialog can be open for minutes: validate the pin/key again.
        let mut args = self.ssh_args(&guard.entry).map_err(|_| COLLECTION_ERROR)?;
        input.extend(serde_json::to_vec(&json!({ "operationId": binding.operation, "environmentId": binding.environment, "releaseId": binding.release, "protectedLogs": protected })).map_err(|_| "Invalid diagnostic request")?);
        input.push(b'\n');
        let privilege = if !protected || root {
            ""
        } else if password {
            "sudo -k -S -p '' -- "
        } else {
            "sudo -n -- "
        };
        args.extend([
            "--".into(),
            guard.entry.target.host.clone(),
            format!("{privilege}{}", collector_command()),
        ]);
        // The read deadline starts after purpose-specific native authorization.
        let bytes = run_bounded(
            self.ssh_program(),
            &args,
            &input,
            Duration::from_secs(15),
            &guard.cancel,
            MAX_REPLY,
        );
        input.fill(0);
        if guard.cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        let bytes = zeroize::Zeroizing::new(bytes.map_err(|_| COLLECTION_ERROR)?);
        self.pinned_ssh_args(&guard.entry)
            .map_err(|_| COLLECTION_ERROR)?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        self.ready().map_err(|_| CANCELLED)?;
        let current = inner.entries.get(id).ok_or("Setup no longer exists")?;
        if Binding::from_entry(current)? != binding
            || guard.cancel.load(Ordering::SeqCst)
            || inner
                .activities
                .get(id)
                .is_none_or(|v| v.token != guard.token)
        {
            return Err("Diagnostic request is no longer current".into());
        }
        let (report, remote_updated_at) =
            report_from_wire(&bytes, current, &binding, protected, guard.token.clone())?;
        if history::active_install_state(&report.state) {
            self.reveal_history(id)?;
        }
        while inner.diagnostic_cache.len() >= CACHE_COUNT {
            inner.diagnostic_cache.remove(0);
        }
        inner.diagnostic_cache.push(CachedReport {
            binding,
            report: report.clone(),
            remote_updated_at,
            cached_at: Instant::now(),
        });
        Ok(report)
    }
    fn cancel_diagnostics(&self, id: &str) -> Result<(), String> {
        environments::validate_id(id)?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        if !inner.entries.contains_key(id) {
            return Err("Unknown setup target".into());
        }
        invalidate(&mut inner, id);
        Ok(())
    }
    fn export_diagnostics(
        &self,
        id: &str,
        report_id: &str,
        downloads: &std::path::Path,
    ) -> Result<String, String> {
        self.ready()?;
        environments::validate_id(id)?;
        environments::validate_id(report_id)?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        inner.diagnostic_cache.retain(|v| {
            v.report.expires_at > now() && v.cached_at.elapsed() < Duration::from_millis(CACHE_TTL)
        });
        let entry = inner.entries.get(id).ok_or("Unknown setup target")?;
        self.pinned_ssh_args(entry)
            .map_err(|_| "Diagnostic host trust changed; verify the saved target before export")?;
        let cached = inner.diagnostic_cache.iter().find(|v| v.report.setup_id == id && v.report.report_id == report_id && v.valid(entry))
            .ok_or("Diagnostic report expired or its operation changed; collect again before exporting")?;
        let bytes = serde_json::to_vec_pretty(&cached.report)
            .map_err(|_| "Cannot format sanitized diagnostic report")?;
        let directory = setup_log_directory(downloads)
            .map_err(|_| "Cannot create a private diagnostic export directory")?;
        let path = directory.join(format!("outpost-diagnostics-{}.json", Uuid::new_v4()));
        private_setup_log_write(&path, &bytes).map_err(|_| {
            "Cannot save diagnostic report privately without overwriting an existing file"
        })?;
        Ok(path.to_string_lossy().into_owned())
    }
}
#[tauri::command]
pub async fn setup_diagnostics(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
    protected_logs: bool,
    password: bool,
) -> Result<DiagnosticReport, String> {
    let setup = setup.inner().clone();
    // Register cancellation/ownership before the blocking pool can queue this read.
    let request = setup.reserve_diagnostics(&id, protected_logs, password)?;
    tauri::async_runtime::spawn_blocking(move || {
        setup.collect_reserved_diagnostics_with(request, authorize)
    })
    .await
    .map_err(|_| "Diagnostic collection interrupted")?
}
#[tauri::command]
pub fn setup_diagnostics_cancel(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<(), String> {
    setup.cancel_diagnostics(&id)
}
#[tauri::command]
pub async fn setup_diagnostics_export(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
    report_id: String,
) -> Result<String, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|_| "Downloads directory unavailable")?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        setup.export_diagnostics(&id, &report_id, &downloads)
    })
    .await
    .map_err(|_| "Diagnostic export interrupted")?
}
#[tauri::command]
pub fn setup_diagnostic_guide(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<guide::Guide, String> {
    setup.diagnostic_guide(&id)
}

#[cfg(test)]
#[path = "server_diagnostics_tests.rs"]
mod tests;
