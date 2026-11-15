//! Operator-only snapshot review and separately gated LIVE DESTRUCTIVE native reset.
//! Live tests are ignored; destructive/reset-recovery operators require separate exact opt-ins.
#![cfg(target_os = "macos")]

use super::super::*;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use std::{
    ffi::OsStr,
    fmt,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
};

const LIVE_ROOT: &str =
    "/Users/sudarshanrajagopalan/Library/Application Support/dev.outpost.desktop";
const WORKING_ID: &str = "be06c19e-6305-4621-9aa9-8bcce9baf7da";
const SOURCE_ID: &str = "0754c27a-0d4e-4322-9a8f-74fa71f9cc4d";
const OPERATION_ID: &str = "645f62a9-37c8-413e-b31e-9372bc2ed774";
const HOST: &str = "surajhomeserver2";
const USER: &str = "surajadmin2";
const KEY: &str = "/Users/sudarshanrajagopalan/.ssh/surajhomeserver2";
const FINGERPRINT: &str = "SHA256:nsTF3++XntFP3pfnvBeVVGsUsSMqgsNazw6lI+nA3UI";
const PORT: u16 = 22;
const MAX_ENTRIES: usize = 8 * 1024 * 1024;

#[path = "server_restart_recovery_operator.rs"]
mod recovery;

type Result<T> = std::result::Result<T, SafeError>;

// Only static classifications or the typed native authorization error may reach output.
#[derive(Serialize)]
struct SafeError {
    phase: &'static str,
    classification: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}
impl SafeError {
    fn new(phase: &'static str, classification: &'static str) -> Self {
        Self {
            phase,
            classification,
            detail: None,
        }
    }
    fn authorization(error: AuthorizationError) -> Self {
        Self {
            phase: "nativeAuthorization",
            classification: "promptFailed",
            detail: Some(error.to_string()),
        }
    }
}
impl fmt::Debug for SafeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Serialization has no fallible user-defined fields and never includes raw errors.
        match serde_json::to_string(self) {
            Ok(value) => f.write_str(&value),
            Err(_) => f.write_str("{\"phase\":\"output\",\"classification\":\"encodingFailed\"}"),
        }
    }
}
fn require(condition: bool, phase: &'static str, classification: &'static str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(SafeError::new(phase, classification))
    }
}
fn opt_in(value: Option<&OsStr>) -> Result<()> {
    require(
        value == Some(OsStr::new("1")),
        "optIn",
        "OUTPOST_OPERATOR_REVIEW=1 required",
    )
}

// Deserialize only review inputs. Logs/errors (including receipt logs), labels and
// endpoints are skipped by serde, not copied and then scrubbed from snapshot files.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewEntry {
    id: String,
    target: Target,
    fingerprint: String,
    phase: String,
    inspection: Option<Inspection>,
    plan: Option<install::InstallPlan>,
    installation: Option<ReviewProgress>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewProgress {
    operation_id: String,
    environment_id: String,
    release_id: String,
    state: String,
    completed_steps: u8,
    total_steps: u8,
    stage: String,
    started_at: u64,
    updated_at: u64,
    #[serde(skip_deserializing, default)]
    log: Vec<String>,
    #[serde(skip_deserializing, default)]
    error: Option<String>,
}
impl ReviewEntry {
    fn into_entry(self) -> Result<Entry> {
        let installation = self
            .installation
            .map(|progress| {
                serde_json::to_value(progress)
                    .and_then(serde_json::from_value)
                    .map_err(|_| SafeError::new("snapshotRead", "invalidReceipt"))
            })
            .transpose()?;
        Ok(Entry {
            id: self.id,
            label: "Operator review snapshot".into(),
            target: self.target,
            fingerprint: self.fingerprint,
            phase: self.phase,
            inspection: self.inspection,
            recommendation: None,
            endpoint: None,
            error: None,
            log: Vec::new(),
            plan: self.plan,
            installation,
            connection_paused: true,
        })
    }
}
struct SelectedEntries(BTreeMap<String, ReviewEntry>);
impl<'de> Deserialize<'de> for SelectedEntries {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Selection;
        impl<'de> Visitor<'de> for Selection {
            type Value = SelectedEntries;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an existing setup journal with two selected entries")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut entries = BTreeMap::new();
                while let Some(id) = map.next_key::<String>()? {
                    if [WORKING_ID, SOURCE_ID].contains(&id.as_str()) {
                        if entries.contains_key(&id) {
                            return Err(serde::de::Error::custom("duplicate selected setup"));
                        }
                        entries.insert(id, map.next_value()?);
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(SelectedEntries(entries))
            }
        }
        deserializer.deserialize_map(Selection)
    }
}
fn select_entries(bytes: &[u8]) -> Result<BTreeMap<String, Entry>> {
    let selected: SelectedEntries = serde_json::from_slice(bytes)
        .map_err(|_| SafeError::new("snapshotRead", "invalidEntries"))?;
    require(
        selected.0.len() == 2,
        "snapshotRead",
        "selectedEntriesMissing",
    )?;
    selected
        .0
        .into_iter()
        .map(|(id, entry)| {
            require(id == entry.id, "preflight", "entryIdentityMismatch")?;
            Ok((id, entry.into_entry()?))
        })
        .collect()
}
fn verify_entries(entries: &BTreeMap<String, Entry>) -> Result<Binding> {
    let working = entries
        .get(WORKING_ID)
        .ok_or_else(|| SafeError::new("preflight", "workingMissing"))?;
    let source = entries
        .get(SOURCE_ID)
        .ok_or_else(|| SafeError::new("preflight", "sourceMissing"))?;
    require(
        entries.len() == 2 && working.id == WORKING_ID && source.id == SOURCE_ID,
        "preflight",
        "entryIdentityMismatch",
    )?;
    for entry in [working, source] {
        require(
            entry.target.host == HOST
                && entry.target.port == PORT
                && entry.fingerprint == FINGERPRINT,
            "preflight",
            "hostOrPinMismatch",
        )?;
        require(
            !matches!(entry.phase.as_str(), "reset" | "restart_pending"),
            "preflight",
            "restartHeld",
        )?;
        entry
            .target
            .validate()
            .map_err(|_| SafeError::new("preflight", "invalidTarget"))?;
        if let Some(inspection) = &entry.inspection {
            inspection
                .validate()
                .map_err(|_| SafeError::new("preflight", "invalidInspection"))?;
        }
        if let Some(plan) = &entry.plan {
            plan.validate()
                .map_err(|_| SafeError::new("preflight", "invalidPlan"))?;
            require(
                plan.operation_id == OPERATION_ID,
                "preflight",
                "operationMismatch",
            )?;
            Expected::from_entry(entry)
                .map_err(|_| SafeError::new("preflight", "planReceiptMismatch"))?;
        } else {
            require(
                entry.installation.is_none(),
                "preflight",
                "receiptWithoutPlan",
            )?;
        }
    }
    // The archived source may have an obsolete SSH username/key. Never use it to connect.
    require(
        working.target.user == USER && working.target.identity_file.as_deref() == Some(KEY),
        "preflight",
        "workingSshMismatch",
    )?;
    require(
        working.inspection.as_ref().is_none_or(|v| v.uid != 0),
        "preflight",
        "unexpectedRootInspection",
    )?;
    let binding = Binding::new(working, source)
        .map_err(|_| SafeError::new("preflight", "invalidOriginalPlan"))?;
    require(
        binding.expected.operation_id == OPERATION_ID,
        "preflight",
        "operationMismatch",
    )?;
    Ok(binding)
}

fn file_stamp(meta: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}
fn read_existing(path: &Path, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    let failure = || SafeError::new("snapshotRead", "unreadableUnsafeOrChangingFile");
    let before = fs::symlink_metadata(path).map_err(|_| failure())?;
    require(
        before.is_file() && before.len() <= limit as u64,
        "snapshotRead",
        "unsafeOrOversizedFile",
    )?;
    let mut file = fs::File::open(path).map_err(|_| failure())?;
    require(
        file_stamp(&before) == file_stamp(&file.metadata().map_err(|_| failure())?),
        "snapshotRead",
        "fileChanged",
    )?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(limit + 1));
    Read::by_ref(&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| failure())?;
    require(
        bytes.len() <= limit
            && file_stamp(&before) == file_stamp(&file.metadata().map_err(|_| failure())?)
            && file_stamp(&before)
                == file_stamp(&fs::symlink_metadata(path).map_err(|_| failure())?),
        "snapshotRead",
        "fileChanged",
    )?;
    Ok(bytes)
}
fn verified_pin(id: &str, bytes: &[u8], expected: &str) -> Result<String> {
    let text = std::str::from_utf8(bytes).map_err(|_| SafeError::new("preflight", "invalidPin"))?;
    let (key, fingerprint) =
        parse_key(text).map_err(|_| SafeError::new("preflight", "invalidPin"))?;
    let alias = Setup::alias(id);
    require(
        fingerprint == expected && text.split_whitespace().next() == Some(alias.as_str()),
        "preflight",
        "pinMismatch",
    )?;
    // Retain only the verified pin, never comments or unrelated lines from the source file.
    Ok(format!("{alias} {key}\n"))
}

struct Snapshot {
    root: PathBuf,
    identity: (u64, u64),
}
impl Snapshot {
    fn new() -> Result<Self> {
        // Fixed macOS scratch parent: TMPDIR cannot redirect writes into live app data.
        let root =
            Path::new("/private/tmp").join(format!("outpost-operator-review-{}", Uuid::new_v4()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| SafeError::new("snapshotCreate", "privateDirectoryFailed"))?;
        let meta = fs::symlink_metadata(&root)
            .map_err(|_| SafeError::new("snapshotCreate", "directoryIdentityUnavailable"))?;
        Ok(Self {
            root,
            identity: (meta.dev(), meta.ino()),
        })
    }
    fn setup(
        &self,
        entries: &BTreeMap<String, Entry>,
        pins: &BTreeMap<String, String>,
    ) -> Result<Setup> {
        let directory = self.root.join("server-setup");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| SafeError::new("snapshotCreate", "setupDirectoryFailed"))?;
        let bytes = serde_json::to_vec(entries)
            .map_err(|_| SafeError::new("snapshotCreate", "entriesEncodingFailed"))?;
        snapshot_write(&directory.join("entries.json"), &bytes)?;
        for (id, pin) in pins {
            require(
                [WORKING_ID, SOURCE_ID].contains(&id.as_str()),
                "snapshotCreate",
                "unexpectedPinId",
            )?;
            snapshot_write(&directory.join(format!("{id}.known_hosts")), pin.as_bytes())?;
        }
        Setup::new(self.root.clone())
            .map_err(|_| SafeError::new("snapshotSetup", "initializationFailed"))
    }
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        // Never follow a replacement root or remove a pre-existing directory on failure.
        if fs::symlink_metadata(&self.root)
            .is_ok_and(|meta| meta.is_dir() && (meta.dev(), meta.ino()) == self.identity)
        {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
fn snapshot_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| SafeError::new("snapshotCreate", "privateFileFailed"))?;
    file.write_all(bytes)
        .map_err(|_| SafeError::new("snapshotCreate", "writeFailed"))
}
fn review_failure(raw: &str, native: Option<AuthorizationError>) -> SafeError {
    if let Some(error) = native {
        return SafeError::authorization(error);
    }
    let (phase, classification) = if raw == server_execution_error("review") {
        (
            "serverExecution",
            "reviewFailedTransportSudoOrHelperUnknown",
        )
    } else if raw.starts_with("[serverProtocol:review]") {
        ("serverProtocol", "reviewIdentityOrScopeInvalid")
    } else if raw.starts_with("[restartRequest:") {
        ("restartRequest", "requestRevalidationFailed")
    } else {
        ("review", "failedWithoutPublicDetail")
    };
    SafeError::new(phase, classification)
}

#[test]
#[ignore = "LIVE read-only SSH + protected native prompt; requires OUTPOST_OPERATOR_REVIEW=1"]
fn outpost2_read_only_restart_review() -> Result<()> {
    opt_in(std::env::var_os("OUTPOST_OPERATOR_REVIEW").as_deref())?;
    let live = Path::new(LIVE_ROOT).join("server-setup");
    let entries = select_entries(&read_existing(&live.join("entries.json"), MAX_ENTRIES)?)?;
    let expected = verify_entries(&entries)?;
    let mut pins = BTreeMap::new();
    for id in [WORKING_ID, SOURCE_ID] {
        let bytes = read_existing(&live.join(format!("{id}.known_hosts")), 4096)?;
        pins.insert(id.into(), verified_pin(id, &bytes, FINGERPRINT)?);
    }
    let snapshot = Snapshot::new()?;
    let setup = snapshot.setup(&entries, &pins)?;
    require(
        setup.ssh_fixture.is_none() && setup.ssh_program() == "/usr/bin/ssh",
        "preflight",
        "nonNativeTransport",
    )?;
    let request = setup
        .reserve_restart(WORKING_ID, SOURCE_ID, true)
        .map_err(|_| SafeError::new("reservation", "restartReservationFailed"))?;
    // Includes the complete persisted source plan and public bootstrap identity, not just its UUID.
    require(
        request.binding == expected
            && request.guard.entry.target == expected.target
            && request.password,
        "preflight",
        "reservedPlanOrTargetChanged",
    )?;
    let mut native_error = None;
    let result = setup.restart_review_with(request, |entry, mode, password, cancel| {
        let result = if mode == "review"
            && password
            && entry.id == WORKING_ID
            && entry.target == expected.target
            && entry.fingerprint == FINGERPRINT
        {
            authorize(entry, mode, password, cancel)
        } else {
            Err(AuthorizationError::InvalidResponse)
        };
        if let Err(error) = &result {
            native_error = Some(*error);
        }
        result
    });
    let review = result.map_err(|raw| review_failure(&raw, native_error))?;
    // RestartReview is the validated public DTO; never serialize Entry, Binding or subprocess bytes.
    let output = serde_json::to_string_pretty(&review)
        .map_err(|_| SafeError::new("output", "reviewEncodingFailed"))?;
    println!("{output}");
    Ok(())
}

const RESET_HELPER_SHA256: &str =
    "b47fca46be69ab592314a69b24c96b51e467a8def0ecb2d2e5db8d9aa794fc8d";
const INSTALLED_APP_BINARY: &str =
    "/Users/sudarshanrajagopalan/Applications/Outpost.app/Contents/MacOS/outpost";
const RESET_BACKUP_FILES: [&str; 5] = [
    "server-setup/entries.json",
    "server-setup/history.json",
    "server-setup/restart-recovery/journal.json",
    "environments/registry.json",
    "environments/restart-fences/journal.json",
];

fn reset_opt_in(host: Option<&OsStr>, operation: Option<&OsStr>) -> Result<()> {
    require(
        host == Some(OsStr::new(HOST)) && operation == Some(OsStr::new(OPERATION_ID)),
        "resetOptIn",
        "exactHostAndOriginalOperationRequired",
    )
}
fn reset_helper_guard(helper: &str) -> Result<()> {
    require(
        format!("{:x}", Sha256::digest(helper.as_bytes())) == RESET_HELPER_SHA256,
        "resetPreflight",
        "reviewedHelperDigestMismatch",
    )
}
fn installed_app_probe() -> Command {
    // pgrep -x matches a regular expression, so the bundle's dot must be literal.
    let pattern = INSTALLED_APP_BINARY.replace('.', "\\.");
    let mut command = Command::new("/usr/bin/pgrep");
    command.args(["-fx", &pattern]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}
fn stopped_app_status(code: Option<i32>) -> Result<()> {
    match code {
        Some(1) => Ok(()),
        Some(0) => Err(SafeError::new(
            "resetAppGuard",
            "installedOutpostStillRunning",
        )),
        _ => Err(SafeError::new("resetAppGuard", "processCheckUnavailable")),
    }
}
fn reset_boundary() -> Result<()> {
    reset_opt_in(
        std::env::var_os("OUTPOST_OPERATOR_RESET").as_deref(),
        std::env::var_os("OUTPOST_OPERATOR_OPERATION").as_deref(),
    )?;
    reset_helper_guard(HELPER)?;
    let mut process = OwnedChild(
        installed_app_probe()
            .spawn()
            .map_err(|_| SafeError::new("resetAppGuard", "processCheckUnavailable"))?,
    );
    let started = Instant::now();
    loop {
        if let Some(status) = process
            .try_wait()
            .map_err(|_| SafeError::new("resetAppGuard", "processCheckUnavailable"))?
        {
            return stopped_app_status(status.code());
        }
        require(
            started.elapsed() < Duration::from_secs(5),
            "resetAppGuard",
            "processCheckTimeout",
        )?;
        thread::sleep(Duration::from_millis(10));
    }
}
fn read_reset_binding() -> Result<Binding> {
    reset_boundary()?;
    let live = Path::new(LIVE_ROOT).join("server-setup");
    let entries = select_entries(&read_existing(&live.join("entries.json"), MAX_ENTRIES)?)?;
    let expected = verify_entries(&entries)?;
    for id in [WORKING_ID, SOURCE_ID] {
        let bytes = read_existing(&live.join(format!("{id}.known_hosts")), 4096)?;
        verified_pin(id, &bytes, FINGERPRINT)?;
    }
    Ok(expected)
}
fn reset_binding_matches(actual: &Binding, expected: &Binding) -> bool {
    // Live bindings retain receipt logs/errors; the pre-open projection deliberately does not.
    // Do not alter the live binding passed to the native restart machinery.
    let mut public = actual.clone();
    if let Some(progress) = public.source_progress.as_object_mut() {
        progress.insert("log".into(), json!([]));
        progress.insert("error".into(), Value::Null);
    }
    public == *expected
}
fn reset_review_scope(review: &RestartReview, expected: &Binding) -> Result<()> {
    require(
        review.source_id == SOURCE_ID
            && review.host == HOST
            && review.operation_id == OPERATION_ID
            && review.environment_id == expected.expected.environment_id
            && review.release_id == expected.expected.release_id
            && environments::validate_id(&review.review_id).is_ok()
            && environments::validate_id(&review.reset_id).is_ok()
            && review.can_reset
            && review.blockers.is_empty()
            && review.state == "failed"
            && review.completed_steps == 4
            && review.total_steps == 12
            && review.services.is_empty()
            && review.paths.len() == PATHS.len()
            && fixed_subset(&review.paths, &PATHS)
            && review.accounts.len() == ACCOUNTS.len()
            && fixed_subset(&review.accounts, &ACCOUNTS),
        "resetScope",
        "expectedFailedStageFourScopeRequired",
    )
}

fn optional_reset_metadata(relative: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
    require(
        RESET_BACKUP_FILES.contains(&relative),
        "resetBackup",
        "pathNotAllowlisted",
    )?;
    let mut directory = PathBuf::from(LIVE_ROOT);
    // Refuse links in the metadata path rather than accidentally backing up another tree.
    let parents = Path::new(relative)
        .parent()
        .ok_or_else(|| SafeError::new("resetBackup", "invalidMetadataPath"))?;
    for component in std::iter::once(None).chain(parents.components().map(Some)) {
        if let Some(component) = component {
            directory.push(component.as_os_str());
        }
        match fs::symlink_metadata(&directory) {
            Ok(meta) => require(meta.is_dir(), "resetBackup", "unsafeMetadataDirectory")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(SafeError::new(
                    "resetBackup",
                    "metadataDirectoryUnavailable",
                ))
            }
        }
    }
    let path = Path::new(LIVE_ROOT).join(relative);
    match fs::symlink_metadata(&path) {
        Ok(_) => read_existing(&path, MAX_ENTRIES).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SafeError::new("resetBackup", "metadataUnavailable")),
    }
}
fn registry_document(bytes: Option<&[u8]>) -> Result<Value> {
    if let Some(bytes) = bytes {
        let metadata: environments::Metadata = serde_json::from_slice(bytes)
            .map_err(|_| SafeError::new("resetRegistry", "invalidMetadata"))?;
        serde_json::to_value(metadata)
            .map_err(|_| SafeError::new("resetRegistry", "invalidMetadata"))
    } else {
        Ok(json!({"version": 1, "legacyMutationsRetired": false,
            "selectedEnvironmentId": null, "environments": {}}))
    }
}
fn registry_peers(mut metadata: Value, target: &str) -> Result<Value> {
    let entries = metadata
        .get_mut("environments")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| SafeError::new("resetRegistry", "invalidMetadata"))?;
    entries.remove(target);
    if metadata["selectedEnvironmentId"].as_str() == Some(target) {
        metadata["selectedEnvironmentId"] = Value::Null;
    }
    Ok(metadata)
}
fn current_registry_document() -> Result<Value> {
    reset_boundary()?;
    let bytes = optional_reset_metadata("environments/registry.json")?
        .ok_or_else(|| SafeError::new("resetRegistry", "registryMissing"))?;
    registry_document(Some(&bytes))
}
fn verify_registry_peers(before: &Value, target: &str) -> Result<()> {
    require(
        registry_peers(current_registry_document()?, target)? == *before,
        "resetRegistry",
        "nonTargetMetadataChanged",
    )
}
fn backup_directory(path: &Path, private: bool) -> Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(SafeError::new("resetBackup", "directoryCreationFailed")),
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|_| SafeError::new("resetBackup", "directoryUnavailable"))?;
    require(
        meta.is_dir() && (!private || meta.mode() & 0o077 == 0),
        "resetBackup",
        "unsafeBackupDirectory",
    )
}
fn sync_backup_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| SafeError::new("resetBackup", "directorySyncFailed"))
}
struct ResetBackup {
    digests: BTreeMap<&'static str, Option<[u8; 32]>>,
    registry: Value,
}
impl ResetBackup {
    fn create() -> Result<Self> {
        reset_boundary()?;
        let project = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| SafeError::new("resetBackup", "projectRootUnavailable"))?;
        let outpost = project.join(".outpost");
        backup_directory(&outpost, false)?;
        let recovery = outpost.join("recovery-645f62a9");
        backup_directory(&recovery, true)?;
        let root = recovery.join(Uuid::new_v4().to_string());
        // No reuse, no Drop deletion and no restoration path: retain even a partial backup.
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| SafeError::new("resetBackup", "uniqueDirectoryCreationFailed"))?;
        let mut result = Self {
            digests: BTreeMap::new(),
            registry: registry_document(None)?,
        };
        for relative in RESET_BACKUP_FILES {
            reset_boundary()?;
            let bytes = optional_reset_metadata(relative)?;
            require(
                relative != "server-setup/entries.json" || bytes.is_some(),
                "resetBackup",
                "entriesMissing",
            )?;
            result.digests.insert(
                relative,
                bytes.as_ref().map(|v| Sha256::digest(v.as_slice()).into()),
            );
            if relative == "environments/registry.json" {
                result.registry = registry_document(bytes.as_ref().map(|v| v.as_slice()))?;
            }
            if let Some(bytes) = bytes {
                let destination = root.join(relative);
                let mut parent = root.clone();
                for component in Path::new(relative)
                    .parent()
                    .into_iter()
                    .flat_map(Path::components)
                {
                    parent.push(component.as_os_str());
                    backup_directory(&parent, true)?;
                }
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&destination)
                    .map_err(|_| SafeError::new("resetBackup", "privateCopyCreationFailed"))?;
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| SafeError::new("resetBackup", "copySyncFailed"))?;
                for directory in destination.parent().into_iter().flat_map(Path::ancestors) {
                    sync_backup_directory(directory)?;
                    if directory == root {
                        break;
                    }
                }
            }
        }
        sync_backup_directory(&root)?;
        sync_backup_directory(&recovery)?;
        sync_backup_directory(&outpost)?;
        sync_backup_directory(project)?;
        Ok(result)
    }
    fn verify_before_open(&self) -> Result<()> {
        reset_boundary()?;
        for (relative, digest) in &self.digests {
            let current = optional_reset_metadata(relative)?;
            let current_digest: Option<[u8; 32]> = current
                .as_ref()
                .map(|v| Sha256::digest(v.as_slice()).into());
            require(
                current_digest == *digest,
                "resetBackup",
                "liveMetadataChangedBeforeOpen",
            )?;
        }
        Ok(())
    }
}

struct CloseLiveSetup(Setup);
impl Drop for CloseLiveSetup {
    fn drop(&mut self) {
        self.0.close();
    }
}
fn reset_dispatch_guard(expected: &Binding, peers: &Value) -> Result<()> {
    require(
        read_reset_binding()? == *expected,
        "resetPreflight",
        "liveTargetOrPlanChanged",
    )?;
    verify_registry_peers(peers, &expected.expected.environment_id)?;
    // This is also the final check after each prompt, immediately before returning
    // zeroizing input to the native pipeline's journal/dispatch boundary.
    reset_boundary()
}
fn checked_reset_authorization(
    mut guard: impl FnMut() -> Result<()>,
    prompt: impl FnOnce() -> std::result::Result<Zeroizing<Vec<u8>>, AuthorizationError>,
) -> Result<Zeroizing<Vec<u8>>> {
    guard()?;
    let secret = prompt().map_err(SafeError::authorization)?;
    guard()?;
    Ok(secret)
}
fn reset_authorize(
    entry: &Entry,
    mode: &str,
    password: bool,
    cancel: &AtomicBool,
    purpose: &str,
    expected: &Binding,
    peers: &Value,
    failure: &mut Option<SafeError>,
) -> std::result::Result<Zeroizing<Vec<u8>>, AuthorizationError> {
    let result = (|| {
        require(
            mode == purpose
                && matches!(purpose, "review" | "apply")
                && password
                && entry.id == WORKING_ID
                && entry.target == expected.target
                && entry.fingerprint == FINGERPRINT,
            "resetAuthorization",
            "purposeOrTargetMismatch",
        )?;
        checked_reset_authorization(
            || reset_dispatch_guard(expected, peers),
            || authorize(entry, mode, password, cancel),
        )
    })();
    result.map_err(|error| {
        *failure = Some(error);
        cancel.store(true, Ordering::SeqCst);
        AuthorizationError::RequestCancel
    })
}

enum ResetError {
    Guard(SafeError),
    Outcome {
        state: &'static str,
        reset_id: String,
    },
}
impl From<SafeError> for ResetError {
    fn from(error: SafeError) -> Self {
        Self::Guard(error)
    }
}
impl fmt::Debug for ResetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Guard(error) => fmt::Debug::fmt(error, f),
            Self::Outcome { state, reset_id } => {
                write!(f, "{}", json!({"state": state, "resetId": reset_id}))
            }
        }
    }
}
fn report_saved_failure(directory: &Path, reset_id: &str) {
    // Read only the schema-validated public diagnostic, never receipt logs or raw subprocess output.
    let message = Journal::read(directory).ok().and_then(|journal| {
        let pending = journal.records.get(reset_id)?;
        let value = serde_json::to_value(pending).ok()?;
        value.get("lastFailure")?.as_str().map(str::to_owned)
    });
    if let Some(message) = message.filter(|value| {
        !value.is_empty() && value.len() <= 1000 && !value.chars().any(char::is_control)
    }) {
        println!("{}", json!({"resetId": reset_id, "helperFailure": message}));
    }
}
fn reset_outcome(
    result: std::result::Result<RestartResult, String>,
    reset_id: &str,
    authorization_failure: Option<SafeError>,
) -> std::result::Result<Entry, ResetError> {
    if let Some(error) = authorization_failure {
        return Err(error.into());
    }
    match result {
        Ok(result)
            if result.reset_id == reset_id
                && result.state == "complete"
                && result.entry.is_some() =>
        {
            result.entry.ok_or_else(|| ResetError::Outcome {
                state: "unknown",
                reset_id: reset_id.into(),
            })
        }
        result => Err(ResetError::Outcome {
            state: if result
                .as_ref()
                .is_ok_and(|v| v.reset_id == reset_id && v.state == "failed")
            {
                "failed"
            } else {
                "unknown"
            },
            reset_id: reset_id.into(),
        }),
    }
}
fn verify_fresh_target(
    fresh: &Entry,
    expected: &Binding,
    previous_ids: &BTreeSet<String>,
) -> Result<()> {
    require(
        environments::validate_id(&fresh.id).is_ok()
            && !previous_ids.contains(&fresh.id)
            && fresh.target == expected.target
            && fresh.fingerprint == FINGERPRINT
            && fresh.phase == "trusted"
            && fresh.plan.is_none()
            && fresh.installation.is_none()
            && fresh.inspection.is_none()
            && fresh.endpoint.is_none()
            && !fresh.connection_paused,
        "resetCompletion",
        "freshTrustedTargetInvalid",
    )
}
fn verify_retired_entries(setup: &Setup, affected: &BTreeSet<String>) -> Result<()> {
    let journal = Journal::read(&setup.directory)
        .map_err(|_| SafeError::new("resetCompletion", "durableJournalUnavailable"))?;
    for id in affected {
        let entry = setup
            .entry(id)
            .map_err(|_| SafeError::new("resetCompletion", "oldEntryMissing"))?;
        require(
            entry.phase == "reset"
                && entry.connection_paused
                && entry.endpoint.is_none()
                && journal.phase(&entry) == Some("reset")
                && setup.restart_entry_allowed(id).is_err(),
            "resetCompletion",
            "oldEntryNotRetired",
        )?;
    }
    Ok(())
}

#[test]
#[ignore = "LIVE DESTRUCTIVE Outpost2 reset; exact OUTPOST_OPERATOR_RESET and OUTPOST_OPERATOR_OPERATION required; installed app must remain closed"]
fn outpost2_live_destructive_reset_and_read_only_inspect() -> std::result::Result<(), ResetError> {
    // No user-data access, backup, app launch/quit or network before these opt-in checks.
    reset_boundary()?;
    let expected = read_reset_binding()?;
    let backup = ResetBackup::create()?;
    let peers = registry_peers(backup.registry.clone(), &expected.expected.environment_id)?;
    require(
        read_reset_binding()? == expected,
        "resetPreflight",
        "liveTargetOrPlanChanged",
    )?;
    backup.verify_before_open()?;
    reset_boundary()?;
    let owned_setup = CloseLiveSetup(
        Setup::new(PathBuf::from(LIVE_ROOT))
            .map_err(|_| SafeError::new("resetSetup", "liveInitializationFailed"))?,
    );
    let setup = &owned_setup.0;
    require(
        setup.directory == Path::new(LIVE_ROOT).join("server-setup")
            && setup.ssh_fixture.is_none()
            && setup.ssh_program() == "/usr/bin/ssh",
        "resetPreflight",
        "liveNativeTransportRequired",
    )?;
    reset_boundary()?;
    let registry = environments::Registry::new(
        PathBuf::from(LIVE_ROOT),
        Arc::new(tokio::sync::Mutex::new(())),
    )
    .map_err(|_| SafeError::new("resetRegistry", "liveInitializationFailed"))?;
    require(
        !registry.fixture_identity,
        "resetRegistry",
        "nativeRegistryRequired",
    )?;
    verify_registry_peers(&peers, &expected.expected.environment_id)?;
    let request = setup
        .reserve_restart(WORKING_ID, SOURCE_ID, true)
        .map_err(|_| SafeError::new("resetReservation", "reviewReservationFailed"))?;
    require(
        reset_binding_matches(&request.binding, &expected)
            && request.password
            && request.guard.entry.target == expected.target,
        "resetPreflight",
        "reservedTargetOrPlanChanged",
    )?;
    let (previous_ids, affected) = {
        let inner = setup
            .inner
            .lock()
            .map_err(|_| SafeError::new("resetPreflight", "setupLockFailed"))?;
        (
            inner.entries.keys().cloned().collect::<BTreeSet<_>>(),
            affected_setup_ids(&inner, &request.binding),
        )
    };
    require(
        affected.contains(WORKING_ID) && affected.contains(SOURCE_ID),
        "resetPreflight",
        "originalEntriesNotAffected",
    )?;
    let mut authorization_failure = None;
    reset_dispatch_guard(&expected, &peers)?;
    let result = setup.restart_review_with(request, |entry, mode, password, cancel| {
        reset_authorize(
            entry,
            mode,
            password,
            cancel,
            "review",
            &expected,
            &peers,
            &mut authorization_failure,
        )
    });
    let review = result
        .map_err(|raw| authorization_failure.unwrap_or_else(|| review_failure(&raw, None)))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&review)
            .map_err(|_| SafeError::new("output", "reviewEncodingFailed"))?
    );
    reset_review_scope(&review, &expected)?;

    reset_dispatch_guard(&expected, &peers)?;
    let apply = setup
        .reserve_restart_apply(WORKING_ID, &review.review_id, HOST, true)
        .map_err(|_| SafeError::new("resetReservation", "applyReservationFailed"))?;
    require(
        reset_binding_matches(&apply.request.binding, &expected)
            && apply.request.reset_id == review.reset_id
            && apply.request.password,
        "resetPreflight",
        "applyTargetOrPlanChanged",
    )?;
    reset_review_scope(&apply.cached.review, &expected)?;
    let mut authorization_failure = None;
    reset_dispatch_guard(&expected, &peers)?;
    let result = setup.restart_apply_with(apply, &registry, |entry, mode, password, cancel| {
        reset_authorize(
            entry,
            mode,
            password,
            cancel,
            "apply",
            &expected,
            &peers,
            &mut authorization_failure,
        )
    });
    // A non-complete result terminates here. No status retry, replay or backup restore.
    if !result
        .as_ref()
        .is_ok_and(|value| value.reset_id == review.reset_id && value.state == "complete")
    {
        report_saved_failure(&setup.directory, &review.reset_id);
    }
    let fresh = reset_outcome(result, &review.reset_id, authorization_failure)?;
    reset_boundary()?;
    verify_fresh_target(&fresh, &expected, &previous_ids)?;
    let saved = setup
        .entry(&fresh.id)
        .map_err(|_| SafeError::new("resetCompletion", "freshEntryMissing"))?;
    verify_fresh_target(&saved, &expected, &previous_ids)?;
    setup
        .pinned_ssh_args(&saved)
        .map_err(|_| SafeError::new("resetCompletion", "freshPinInvalid"))?;
    verify_retired_entries(setup, &affected)?;
    require(
        registry
            .restart_unfenced(&expected.expected.environment_id)
            .is_err(),
        "resetCompletion",
        "targetFenceMissing",
    )?;
    let metadata = current_registry_document()?;
    require(
        metadata["environments"]
            .get(&expected.expected.environment_id)
            .is_none(),
        "resetCompletion",
        "targetRegistryEntryNotRemoved",
    )?;
    verify_registry_peers(&peers, &expected.expected.environment_id)?;

    reset_boundary()?;
    let inspected = setup
        .inspect(&fresh.id)
        .map_err(|_| SafeError::new("freshInspection", "readOnlyInspectionFailed"))?;
    let inspection = inspected
        .inspection
        .as_ref()
        .ok_or_else(|| SafeError::new("freshInspection", "inspectionMissing"))?;
    require(
        inspected.id == fresh.id
            && inspected.target == expected.target
            && inspected.fingerprint == FINGERPRINT
            && inspected.plan.is_none()
            && inspected.installation.is_none()
            && !inspection.native_present,
        "freshInspection",
        "nativeInstallationStillPresentOrTargetChanged",
    )?;
    verify_retired_entries(setup, &affected)?;
    verify_registry_peers(&peers, &expected.expected.environment_id)?;
    println!(
        "{}",
        json!({"freshId": inspected.id, "recommendation": inspection.recommendation()})
    );
    Ok(())
}

#[cfg(test)]
mod nonlive {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn records() -> Value {
        let plan = json!({
            "planId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "operationId": OPERATION_ID,
            "environmentId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "releaseId": format!("host-{}", "a".repeat(20)),
            "sha256": "a".repeat(64), "size": 1, "expiresAt": 0, "browser": true,
            "fullControl": false, "coexistenceRequired": false,
            "deviceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "publicKey": STANDARD.encode([7; 32]), "nodeVersion": "24.22.1"
        });
        let mut working = json!({
            "id": WORKING_ID, "label": "secret-canary", "target": {"host": HOST, "user": USER, "port": PORT, "identityFile": KEY},
            "fingerprint": FINGERPRINT, "phase": "trusted", "inspection": null,
            "log": ["secret-canary"], "error": "secret-canary", "endpoint": "secret-canary",
            "plan": null, "installation": null
        });
        let mut source = working.clone();
        source["id"] = json!(SOURCE_ID);
        source["target"]["user"] = json!("obsolete-admin");
        source["target"]["identityFile"] = json!("/nonexistent/obsolete-key");
        source["plan"] = plan.clone();
        source["installation"] = json!({
            "operationId": OPERATION_ID, "environmentId": plan["environmentId"], "releaseId": plan["releaseId"],
            "state": "failed", "completedSteps": 4, "totalSteps": 12, "stage": "Browser runtime",
            "startedAt": 1, "updatedAt": 2, "log": ["secret-canary"], "error": "secret-canary"
        });
        working["recommendation"] = json!("secret-canary");
        json!({WORKING_ID: working, SOURCE_ID: source, "unrelated": {"notEvenAnEntry": "secret-canary"}})
    }
    fn selected(value: &Value) -> BTreeMap<String, Entry> {
        select_entries(&serde_json::to_vec(value).unwrap()).unwrap()
    }

    #[test]
    fn exact_opt_in_required() {
        for value in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new("0")),
            Some(OsStr::new("true")),
            Some(OsStr::new("1 ")),
        ] {
            assert!(opt_in(value).is_err());
        }
        assert!(opt_in(Some(OsStr::new("1"))).is_ok());
    }

    #[test]
    fn only_two_minimal_records_and_no_logs_are_retained() {
        let entries = selected(&records());
        assert_eq!(entries.len(), 2);
        assert!(!serde_json::to_string(&entries)
            .unwrap()
            .contains("secret-canary"));
        assert!(verify_entries(&entries).is_ok());
        let mut missing = records();
        missing.as_object_mut().unwrap().remove(SOURCE_ID);
        assert!(select_entries(&serde_json::to_vec(&missing).unwrap()).is_err());
        let value = records();
        let duplicate = format!(
            "{{\"{WORKING_ID}\":{},\"{WORKING_ID}\":{},\"{SOURCE_ID}\":{}}}",
            value[WORKING_ID], value[WORKING_ID], value[SOURCE_ID]
        );
        assert!(select_entries(duplicate.as_bytes()).is_err());
    }

    #[test]
    fn unexpected_targets_plans_receipts_and_holds_fail_preflight() {
        for (id, pointer, replacement) in [
            (WORKING_ID, "/id", json!(SOURCE_ID)),
            (WORKING_ID, "/target/host", json!("other.example")),
            (WORKING_ID, "/target/user", json!("root")),
            (WORKING_ID, "/target/port", json!(2222)),
            (WORKING_ID, "/target/identityFile", json!(null)),
            (WORKING_ID, "/fingerprint", json!("other")),
            (SOURCE_ID, "/target/host", json!("other.example")),
            (SOURCE_ID, "/fingerprint", json!("other")),
            (SOURCE_ID, "/plan/operationId", json!(WORKING_ID)),
            (SOURCE_ID, "/plan/sha256", json!("invalid")),
            (SOURCE_ID, "/installation/operationId", json!(WORKING_ID)),
            (SOURCE_ID, "/plan", json!(null)),
            (SOURCE_ID, "/phase", json!("restart_pending")),
            (WORKING_ID, "/phase", json!("reset")),
        ] {
            let mut value = records();
            *value[id].pointer_mut(pointer).unwrap() = replacement;
            let result = select_entries(&serde_json::to_vec(&value).unwrap())
                .and_then(|entries| verify_entries(&entries));
            assert!(result.is_err(), "{id}: {pointer}");
        }
    }

    #[test]
    fn pins_require_exact_alias_and_fingerprint() {
        let mut key = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
        key.extend([6; 32]);
        let pin = format!(
            "{} ssh-ed25519 {}\n",
            Setup::alias(WORKING_ID),
            STANDARD.encode(key)
        );
        let (_, fingerprint) = parse_key(&pin).unwrap();
        assert_eq!(
            verified_pin(WORKING_ID, pin.as_bytes(), &fingerprint).unwrap(),
            pin
        );
        assert!(verified_pin(SOURCE_ID, pin.as_bytes(), &fingerprint).is_err());
        assert!(verified_pin(WORKING_ID, pin.as_bytes(), FINGERPRINT).is_err());
        assert!(verified_pin(WORKING_ID, format!("{pin}{pin}").as_bytes(), &fingerprint).is_err());
    }

    #[test]
    fn snapshot_is_private_uses_real_ssh_and_removes_only_its_own_root() {
        let neighbor = Snapshot::new().unwrap();
        snapshot_write(&neighbor.root.join("keep"), b"untouched").unwrap();
        let snapshot = Snapshot::new().unwrap();
        let root = snapshot.root.clone();
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let entries = selected(&records());
        let pins = BTreeMap::from([
            (WORKING_ID.into(), "public test pin".into()),
            (SOURCE_ID.into(), "public test pin".into()),
        ]);
        let setup = snapshot.setup(&entries, &pins).unwrap();
        assert!(setup.ssh_fixture.is_none());
        assert_eq!(setup.ssh_program(), "/usr/bin/ssh");
        assert_eq!(setup.inner.lock().unwrap().entries.len(), 2);
        for name in [
            "entries.json".to_string(),
            format!("{WORKING_ID}.known_hosts"),
            format!("{SOURCE_ID}.known_hosts"),
        ] {
            let path = setup.directory.join(name);
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert!(!String::from_utf8(fs::read(path).unwrap())
                .unwrap()
                .contains("secret-canary"));
        }
        drop(setup);
        drop(snapshot);
        assert!(!root.exists());
        assert_eq!(fs::read(neighbor.root.join("keep")).unwrap(), b"untouched");
    }

    #[test]
    fn replaced_snapshot_root_is_not_followed_or_removed() {
        let neighbor = Snapshot::new().unwrap();
        snapshot_write(&neighbor.root.join("keep"), b"untouched").unwrap();
        let snapshot = Snapshot::new().unwrap();
        let original = snapshot.root.clone();
        let moved = neighbor.root.join("moved-owned-snapshot");
        fs::rename(&original, &moved).unwrap();
        symlink(&neighbor.root, &original).unwrap();
        drop(snapshot);
        assert!(fs::symlink_metadata(&original)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(neighbor.root.join("keep")).unwrap(), b"untouched");
        fs::remove_file(original).unwrap();
    }

    #[test]
    fn read_existing_rejects_symlinks_and_oversized_inputs_without_writes() {
        let snapshot = Snapshot::new().unwrap();
        let path = snapshot.root.join("source");
        snapshot_write(&path, b"unchanged").unwrap();
        let before = file_stamp(&fs::metadata(&path).unwrap());
        assert_eq!(&**read_existing(&path, 32).unwrap(), b"unchanged");
        assert!(read_existing(&path, 2).is_err());
        let link = snapshot.root.join("link");
        symlink(&path, &link).unwrap();
        assert!(read_existing(&link, 32).is_err());
        assert_eq!(file_stamp(&fs::metadata(&path).unwrap()), before);
    }

    fn reset_review_fixture() -> (Binding, RestartReview) {
        let binding = verify_entries(&selected(&records())).unwrap();
        let review = RestartReview {
            review_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(),
            reset_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee".into(),
            source_id: SOURCE_ID.into(),
            host: HOST.into(),
            operation_id: OPERATION_ID.into(),
            environment_id: binding.expected.environment_id.clone(),
            release_id: binding.expected.release_id.clone(),
            expires_at: u64::MAX,
            paths: [
                "/opt/outpost-native",
                "/etc/outpost-native",
                "/var/lib/outpost-native",
            ]
            .map(String::from)
            .to_vec(),
            services: vec![],
            accounts: [
                "user:outpost-coord",
                "user:outpost-pi",
                "user:outpost-build",
                "group:outpost-coord",
                "group:outpost-pi",
                "group:outpost-build",
                "group:outpost-workspaces",
            ]
            .map(String::from)
            .to_vec(),
            preserved: vec![],
            warnings: vec![],
            blockers: vec![],
            can_reset: true,
            state: "failed".into(),
            completed_steps: 4,
            total_steps: 12,
        };
        (binding, review)
    }

    #[test]
    fn reset_requires_both_exact_opt_ins_and_reviewed_compiled_helper() {
        assert!(reset_opt_in(Some(OsStr::new(HOST)), Some(OsStr::new(OPERATION_ID))).is_ok());
        for wrong in [
            None,
            Some(OsStr::new("1")),
            Some(OsStr::new("surajhomeserver2 ")),
            Some(OsStr::new("other")),
        ] {
            assert!(reset_opt_in(wrong, Some(OsStr::new(OPERATION_ID))).is_err());
            assert!(reset_opt_in(Some(OsStr::new(HOST)), wrong).is_err());
        }
        assert!(reset_helper_guard(HELPER).is_ok());
        assert!(reset_helper_guard(&format!("{HELPER}\n")).is_err());
    }

    #[test]
    fn reset_app_probe_is_exact_and_only_absence_passes() {
        let command = installed_app_probe();
        assert_eq!(command.get_program(), OsStr::new("/usr/bin/pgrep"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("-fx"),
                OsStr::new(
                    "/Users/sudarshanrajagopalan/Applications/Outpost\\.app/Contents/MacOS/outpost"
                ),
            ]
        );
        assert!(stopped_app_status(Some(1)).is_ok());
        for code in [None, Some(0), Some(2), Some(3), Some(-1)] {
            assert!(stopped_app_status(code).is_err());
        }
        assert_eq!(
            RESET_BACKUP_FILES,
            [
                "server-setup/entries.json",
                "server-setup/history.json",
                "server-setup/restart-recovery/journal.json",
                "environments/registry.json",
                "environments/restart-fences/journal.json",
            ]
        );
    }

    #[test]
    fn reset_scope_requires_stage_four_and_exact_unactivated_native_scope() {
        let (binding, review) = reset_review_fixture();
        assert!(reset_review_scope(&review, &binding).is_ok());
        let changes: Vec<Box<dyn Fn(&mut RestartReview)>> = vec![
            Box::new(|r| r.can_reset = false),
            Box::new(|r| r.blockers.push("blocked".into())),
            Box::new(|r| r.state = "running".into()),
            Box::new(|r| r.completed_steps = 5),
            Box::new(|r| r.total_steps = 11),
            Box::new(|r| r.services.push("outpost-native-worker.service".into())),
            Box::new(|r| {
                r.paths.pop();
            }),
            Box::new(|r| r.paths[0] = "/home".into()),
            Box::new(|r| r.paths[0] = r.paths[1].clone()),
            Box::new(|r| {
                r.accounts.pop();
            }),
            Box::new(|r| r.accounts.push("user:root".into())),
            Box::new(|r| r.accounts[0] = "user:root".into()),
            Box::new(|r| r.accounts[0] = r.accounts[1].clone()),
            Box::new(|r| r.source_id = WORKING_ID.into()),
            Box::new(|r| r.host = "another-host".into()),
            Box::new(|r| r.operation_id = WORKING_ID.into()),
            Box::new(|r| r.environment_id = WORKING_ID.into()),
            Box::new(|r| r.release_id = "other-release".into()),
            Box::new(|r| r.reset_id = "invalid".into()),
        ];
        for change in changes {
            let mut changed = review.clone();
            change(&mut changed);
            assert!(reset_review_scope(&changed, &binding).is_err());
        }
    }

    #[test]
    fn reset_binding_projection_ignores_only_receipt_log_and_error() {
        let (binding, _) = reset_review_fixture();
        let mut live = binding.clone();
        live.source_progress["log"] = json!(["secret-canary"]);
        live.source_progress["error"] = json!("secret-canary");
        assert!(reset_binding_matches(&live, &binding));
        live.source_progress["completedSteps"] = json!(5);
        assert!(!reset_binding_matches(&live, &binding));
        let mut changed = binding.clone();
        changed.source_plan["sha256"] = json!("b".repeat(64));
        assert!(!reset_binding_matches(&changed, &binding));
        changed = binding.clone();
        changed.target.user = "other-user".into();
        assert!(!reset_binding_matches(&changed, &binding));
    }

    #[test]
    fn reset_authorization_checks_before_prompt_and_after_prompt_before_dispatch() {
        use std::cell::Cell;
        for fail_at in [Some(1), Some(2), None] {
            let checks = Cell::new(0);
            let prompts = Cell::new(0);
            let result = checked_reset_authorization(
                || {
                    checks.set(checks.get() + 1);
                    require(
                        fail_at != Some(checks.get()),
                        "resetAppGuard",
                        "installedOutpostStillRunning",
                    )
                },
                || {
                    prompts.set(prompts.get() + 1);
                    Ok(Zeroizing::new(b"synthetic-secret-canary\n".to_vec()))
                },
            );
            assert_eq!(prompts.get(), if fail_at == Some(1) { 0 } else { 1 });
            assert_eq!(checks.get(), if fail_at == Some(1) { 1 } else { 2 });
            if fail_at.is_some() {
                assert!(!format!("{:?}", result.unwrap_err()).contains("synthetic-secret-canary"));
            } else {
                assert!(result.is_ok());
            }
        }
        let failed_prompt = checked_reset_authorization(
            || Ok(()),
            || {
                Err(AuthorizationError::ProcessFailure {
                    phase: authorization::ProcessPhase::AppleScript,
                    code: Some(-1743),
                })
            },
        );
        let error = format!("{:?}", failed_prompt.unwrap_err());
        assert!(error.contains("appleScript") && error.contains("-1743"));
    }

    #[test]
    fn reset_peer_projection_preserves_all_non_target_metadata() {
        let target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let peer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let before = json!({"version": 1, "legacyMutationsRetired": true,
        "selectedEnvironmentId": target, "environments": {
            target: {"environmentId": target, "label": "Disposable"},
            peer: {"environmentId": peer, "label": "Peer", "routes": ["https://peer.example"],
                "activeRoute": "https://peer.example", "ssh": null}
        }});
        let expected = registry_peers(before.clone(), target).unwrap();
        let mut after = before.clone();
        after["environments"]
            .as_object_mut()
            .unwrap()
            .remove(target);
        after["selectedEnvironmentId"] = Value::Null;
        assert_eq!(registry_peers(after.clone(), target).unwrap(), expected);
        for (pointer, replacement) in [
            (format!("/environments/{peer}/label"), json!("Changed")),
            (
                format!("/environments/{peer}/routes"),
                json!(["https://other.example"]),
            ),
            (
                format!("/environments/{peer}/ssh"),
                json!({"generation": 1}),
            ),
            ("/legacyMutationsRetired".into(), json!(false)),
            ("/selectedEnvironmentId".into(), json!(peer)),
        ] {
            let mut changed = after.clone();
            *changed.pointer_mut(&pointer).unwrap() = replacement;
            assert_ne!(registry_peers(changed, target).unwrap(), expected);
        }
        after["environments"].as_object_mut().unwrap().remove(peer);
        assert_ne!(registry_peers(after, target).unwrap(), expected);
    }

    #[test]
    fn reset_uncertain_outcomes_expose_only_public_state_and_original_reset_id() {
        let (_, review) = reset_review_fixture();
        for state in ["unknown", "failed", "unexpected", "complete"] {
            let result = RestartResult {
                state: state.into(),
                reset_id: review.reset_id.clone(),
                entry: None,
                message: "secret-canary".into(),
            };
            let error = reset_outcome(Ok(result), &review.reset_id, None).unwrap_err();
            let value: Value = serde_json::from_str(&format!("{error:?}")).unwrap();
            assert_eq!(
                value,
                json!({"state": if state == "failed" { "failed" } else { "unknown" }, "resetId": review.reset_id})
            );
        }
        let error = reset_outcome(Err("secret-canary".into()), &review.reset_id, None).unwrap_err();
        assert_eq!(
            serde_json::from_str::<Value>(&format!("{error:?}")).unwrap(),
            json!({"state": "unknown", "resetId": review.reset_id})
        );
    }

    #[test]
    fn reset_fresh_entry_must_be_new_trusted_and_without_an_installation_plan() {
        let entries = selected(&records());
        let expected = verify_entries(&entries).unwrap();
        let previous = entries.keys().cloned().collect();
        let mut fresh = entries[WORKING_ID].clone();
        fresh.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into();
        fresh.connection_paused = false;
        assert!(verify_fresh_target(&fresh, &expected, &previous).is_ok());
        fresh.id = WORKING_ID.into();
        assert!(verify_fresh_target(&fresh, &expected, &previous).is_err());
        fresh.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into();
        fresh.plan = entries[SOURCE_ID].plan.clone();
        assert!(verify_fresh_target(&fresh, &expected, &previous).is_err());
        fresh.plan = None;
        fresh.phase = "review".into();
        assert!(verify_fresh_target(&fresh, &expected, &previous).is_err());
    }

    #[test]
    fn errors_only_expose_classification_and_typed_native_phase() {
        let native = AuthorizationError::ProcessFailure {
            phase: authorization::ProcessPhase::AppleScript,
            code: Some(-1743),
        };
        let error = format!("{:?}", review_failure("secret-canary", Some(native)));
        assert!(error.contains("appleScript"));
        assert!(error.contains("-1743"));
        assert!(!error.contains("secret-canary"));
        for raw in [
            "secret-canary",
            "[restartRequest:secret-canary]",
            "[serverProtocol:review] secret-canary",
            server_execution_error("review"),
        ] {
            let error = format!("{:?}", review_failure(raw, None));
            assert!(!error.contains("secret-canary"));
            assert!(!error.contains("localAuthorization"));
            assert!(serde_json::from_str::<Value>(&error).is_ok());
        }
    }
}
