//! Ignored, exact-target fresh setup after native completion of the held reset.
//! Never repairs metadata, resumes an old operation, or repeats a launch receipt.
use super::*;
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
};

type OperatorResult<T> = Result<T, &'static str>;
const REPO: &str = "/Users/sudarshanrajagopalan/Developer/Outpost";
const ROOT: &str = "/Users/sudarshanrajagopalan/Library/Application Support/dev.outpost.desktop";
const APP: &str = "/Users/sudarshanrajagopalan/Applications/Outpost.app/Contents/MacOS/outpost";
const RESET: &str = "5e5f59b9-ccaa-4402-ac8d-10fd315978d4";
const FRESH: &str = "2e1c768b-fb41-4f33-912e-a86cbc038098";
const WORKING: &str = "be06c19e-6305-4621-9aa9-8bcce9baf7da";
const SOURCE: &str = "0754c27a-0d4e-4322-9a8f-74fa71f9cc4d";
const OLD_OPERATION: &str = "645f62a9-37c8-413e-b31e-9372bc2ed774";
const OLD_ENVIRONMENT: &str = "cbfedef7-2f91-4b6d-8ba8-d4c1f5ea5a6b";
const HOST: &str = "surajhomeserver2";
const KEY: &str = "/Users/sudarshanrajagopalan/.ssh/surajhomeserver2";
const FINGERPRINT: &str = "SHA256:nsTF3++XntFP3pfnvBeVVGsUsSMqgsNazw6lI+nA3UI";
const RELEASE: &str = "host-5954216307cbf96196fc";
const ARCHIVE_SHA: &str = "acab95c9d7bbe1113e9bdc31a3fe6f548078b0e9293fae241396b5e31c91e822";
const INSTALLER_SHA: &str = "d5ce74e40751e1ab9cb736f5e8f72f368f364e9e78d812a61fd952a7e47814ce";
const ARCHIVE_SIZE: u64 = 229135;
const MAX_DOCUMENT: usize = 8 * 1024 * 1024;
const BROKER_LIMIT: usize = 1024 * 1024;
const BRIDGE: &str = include_str!("../../../scripts/outpost2_install_broker.py");
const RESET_FILE: &str = "server-setup/restart-recovery/journal.json";
const FENCES_FILE: &str = "environments/restart-fences/journal.json";
static INTERACTION_LOCK: Mutex<()> = Mutex::new(());

fn require(condition: bool, message: &'static str) -> OperatorResult<()> {
    if condition {
        Ok(())
    } else {
        Err(message)
    }
}
fn opt_in(host: Option<&OsStr>, fresh: Option<&OsStr>) -> OperatorResult<()> {
    require(
        host == Some(OsStr::new(HOST)) && fresh == Some(OsStr::new(FRESH)),
        "Exact OUTPOST_OPERATOR_SETUP and OUTPOST_OPERATOR_FRESH opt-ins required",
    )
}
fn target() -> Target {
    Target {
        host: HOST.into(),
        user: "surajadmin2".into(),
        port: 22,
        identity_file: Some(KEY.into()),
    }
}
fn app_status(code: Option<i32>) -> OperatorResult<()> {
    require(
        code == Some(1),
        "Installed Outpost must remain closed; process check failed or app is running",
    )
}
fn boundary() -> OperatorResult<()> {
    opt_in(
        std::env::var_os("OUTPOST_OPERATOR_SETUP").as_deref(),
        std::env::var_os("OUTPOST_OPERATOR_FRESH").as_deref(),
    )?;
    let mut child = OwnedChild(
        Command::new("/usr/bin/pgrep")
            .args(["-fx", &APP.replace('.', "\\.")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Cannot verify installed app is closed")?,
    );
    let start = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Cannot verify installed app is closed")?
        {
            return app_status(status.code());
        }
        require(
            start.elapsed() < Duration::from_secs(5),
            "App-closed check timed out",
        )?;
        thread::sleep(Duration::from_millis(20));
    }
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainGetUserInteractionAllowed(state: *mut u8) -> i32;
    fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
}
extern "C" {
    fn geteuid() -> u32;
    fn flock(fd: i32, operation: i32) -> i32;
}
trait InteractionPolicy {
    fn get(&self) -> OperatorResult<bool>;
    fn set(&self, allowed: bool) -> OperatorResult<()>;
}
struct SecurityInteraction;
impl InteractionPolicy for SecurityInteraction {
    fn get(&self) -> OperatorResult<bool> {
        let mut allowed = 0;
        // SDK SecKeychain.h uses Boolean (u8) and OSStatus (i32).
        require(
            unsafe { SecKeychainGetUserInteractionAllowed(&mut allowed) } == 0,
            "Noninteractive Keychain access unavailable; no identity read attempted",
        )?;
        Ok(allowed != 0)
    }
    fn set(&self, allowed: bool) -> OperatorResult<()> {
        require(
            unsafe { SecKeychainSetUserInteractionAllowed(u8::from(allowed)) } == 0,
            "Could not set/restore Keychain interaction policy; no ACL was changed",
        )
    }
}
struct NoInteraction<P: InteractionPolicy> {
    policy: P,
    previous: bool,
    restored: bool,
}
impl<P: InteractionPolicy> NoInteraction<P> {
    fn enter(policy: P) -> OperatorResult<Self> {
        let previous = policy.get()?;
        let guard = Self {
            policy,
            previous,
            restored: false,
        };
        guard.policy.set(false)?;
        require(
            !guard.policy.get()?,
            "Keychain interaction suppression could not be confirmed",
        )?;
        Ok(guard)
    }
    fn restore(&mut self) -> OperatorResult<()> {
        self.policy.set(self.previous)?;
        require(
            self.policy.get()? == self.previous,
            "Keychain interaction restoration could not be confirmed",
        )?;
        self.restored = true;
        Ok(())
    }
}
impl<P: InteractionPolicy> Drop for NoInteraction<P> {
    fn drop(&mut self) {
        if !self.restored {
            let _ = self.policy.set(self.previous);
        }
    }
}

fn stamp(m: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn read_regular(path: &Path, limit: usize, private: bool) -> OperatorResult<Vec<u8>> {
    // Darwin O_NOFOLLOW | O_NONBLOCK; a replaced FIFO must not block this operator.
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(0x104)
        .open(path)
        .map_err(|_| "Required owned regular file unavailable")?;
    let before = file.metadata().map_err(|_| "File inspection failed")?;
    require(
        before.is_file()
            && before.uid() == unsafe { geteuid() }
            && before.nlink() == 1
            && before.mode() & (if private { 0o077 } else { 0o022 }) == 0
            && before.len() <= limit as u64,
        "Unsafe or oversized operator input",
    )?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Input read failed")?;
    require(
        bytes.len() <= limit
            && stamp(&before) == stamp(&file.metadata().map_err(|_| "File changed")?)
            && stamp(&before) == stamp(&fs::symlink_metadata(path).map_err(|_| "File changed")?),
        "Input changed during read",
    )?;
    Ok(bytes)
}
fn document(root: &Path, relative: &str) -> OperatorResult<Value> {
    serde_json::from_slice(&read_regular(&root.join(relative), MAX_DOCUMENT, true)?)
        .map_err(|_| "Native metadata is invalid; do not repair it with this operator")
}
fn owned_directory(path: &Path) -> OperatorResult<(u64, u64)> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Native directory missing")?;
    require(
        metadata.is_dir() && metadata.uid() == unsafe { geteuid() } && metadata.mode() & 0o077 == 0,
        "Native directory is not private, owned and link-free",
    )?;
    Ok((metadata.dev(), metadata.ino()))
}
struct OperatorLease {
    _directory: fs::File,
}
impl OperatorLease {
    fn acquire(root: &Path) -> OperatorResult<Self> {
        let identity = owned_directory(root)?;
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x104)
            .open(root)
            .map_err(|_| "Cannot acquire the existing native directory")?;
        let metadata = directory
            .metadata()
            .map_err(|_| "Native directory changed")?;
        require(
            metadata.is_dir() && (metadata.dev(), metadata.ino()) == identity,
            "Native directory changed",
        )?;
        // Darwin LOCK_EX | LOCK_NB on the existing directory: no lock file or metadata writes.
        require(
            unsafe { flock(directory.as_raw_fd(), 0x06) } == 0,
            "Another fresh-install operator owns this native directory",
        )?;
        Ok(Self {
            _directory: directory,
        })
    }
}
fn verify_pin(root: &Path, id: &str) -> OperatorResult<()> {
    let bytes = read_regular(
        &root.join(format!("server-setup/{id}.known_hosts")),
        16384,
        true,
    )?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Invalid host pin")?;
    let (_, fingerprint) = parse_key(text).map_err(|_| "Invalid host pin")?;
    require(
        fingerprint == FINGERPRINT
            && text.split_whitespace().next() == Some(Setup::alias(id).as_str()),
        "Host pin changed",
    )
}
fn completed_reset(journal: &Value, entries: &Value) -> OperatorResult<(String, String)> {
    require(
        journal["schemaVersion"] == 1
            && journal["records"]
                .as_object()
                .is_some_and(|records| records.len() == 1),
        "Expected exactly the reviewed reset journal",
    )?;
    let reset = &journal["records"][RESET];
    let binding = &reset["binding"];
    let expected = &binding["expected"];
    let reserved = &reset["fresh"];
    require(
        reset["resetId"] == RESET
            && reset["remoteComplete"] == true
            && reset["localComplete"] == true
            && binding["id"] == WORKING
            && binding["sourceId"] == SOURCE
            && binding["target"]
                == serde_json::to_value(target()).map_err(|_| "Invalid fixed target")?
            && binding["fingerprint"] == FINGERPRINT
            && expected["operationId"] == OLD_OPERATION
            && expected["environmentId"] == OLD_ENVIRONMENT
            && expected["releaseId"] == "host-fa9eb6b5d217af95b920"
            && expected["sha256"]
                == "f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57"
            && expected["size"] == 223402
            && reserved["id"] == FRESH
            && reserved["target"] == binding["target"]
            && reserved["fingerprint"] == FINGERPRINT
            && reserved["phase"] == "trusted"
            && reserved["plan"].is_null()
            && reserved["installation"].is_null()
            && reserved["inspection"].is_null()
            && reserved["endpoint"].is_null()
            && reserved["connectionPaused"] == false,
        "Exact held reset has not completed normally; fresh setup is forbidden",
    )?;
    let affected = reset["affected"]
        .as_array()
        .ok_or("Reset affected IDs missing")?;
    require(
        affected.contains(&json!(WORKING))
            && affected.contains(&json!(SOURCE))
            && !affected.contains(&json!(FRESH)),
        "Retired IDs do not match reset",
    )?;
    for id in affected {
        let id = id.as_str().ok_or("Invalid retired setup ID")?;
        let entry = &entries[id];
        require(
            entry["id"] == id
                && entry["phase"] == "reset"
                && entry["connectionPaused"] == true
                && entry["endpoint"].is_null(),
            "Original setup is not retired",
        )?;
    }
    require(
        entries[SOURCE]["plan"] == binding["sourcePlan"]
            && entries[SOURCE]["installation"] == binding["sourceProgress"]
            && entries[WORKING]["plan"] == binding["workingPlan"]
            && entries[WORKING]["inspection"] == binding["workingInspection"],
        "Original operation evidence changed",
    )?;
    let device = expected["deviceId"]
        .as_str()
        .ok_or("Original device identity missing")?
        .to_string();
    let public = expected["publicKey"]
        .as_str()
        .ok_or("Original public identity missing")?
        .to_string();
    require(
        environments::validate_id(&device).is_ok()
            && STANDARD.decode(&public).is_ok_and(|key| key.len() == 32)
            && entries[SOURCE]["plan"]["deviceId"] == device
            && entries[SOURCE]["plan"]["publicKey"] == public,
        "Original device identity is invalid",
    )?;
    Ok((device, public))
}
fn fresh_entry(entries: &Value, expected: &(String, String)) -> OperatorResult<Entry> {
    let entry: Entry = serde_json::from_value(entries[FRESH].clone())
        .map_err(|_| "Reserved fresh entry missing or invalid")?;
    require(
        entry.id == FRESH
            && entry.target == target()
            && entry.fingerprint == FINGERPRINT
            && !entry.connection_paused
            && !matches!(entry.phase.as_str(), "reset" | "restart_pending"),
        "Fresh target changed or is held",
    )?;
    if let Some(plan) = &entry.plan {
        plan.validate().map_err(|_| "Fresh native plan invalid")?;
        require(
            plan.browser
                && plan.full_control
                && plan.device_id == expected.0
                && plan.public_key == expected.1
                && plan.release_id == RELEASE
                && plan.sha256 == ARCHIVE_SHA
                && plan.size == ARCHIVE_SIZE,
            "Fresh plan does not match approved capabilities, identity or bundle",
        )?;
        let ids = [&plan.plan_id, &plan.operation_id, &plan.environment_id];
        require(
            ids.iter().collect::<BTreeSet<_>>().len() == 3
                && ids.iter().all(|id| {
                    ![
                        OLD_OPERATION,
                        OLD_ENVIRONMENT,
                        FRESH,
                        RESET,
                        SOURCE,
                        WORKING,
                    ]
                    .contains(&id.as_str())
                }),
            "Fresh IDs reuse an old authority",
        )?;
        for (id, other) in entries.as_object().ok_or("Invalid entries")? {
            if id != FRESH && !other["plan"].is_null() {
                require(
                    other["plan"]["operationId"] != plan.operation_id
                        && other["plan"]["environmentId"] != plan.environment_id
                        && other["plan"]["planId"] != plan.plan_id,
                    "Fresh IDs conflict with another setup",
                )?;
            }
        }
        if let Some(progress) = &entry.installation {
            require(
                progress.operation_id == plan.operation_id
                    && progress.environment_id == plan.environment_id
                    && progress.release_id == plan.release_id
                    && progress.total_steps == 12,
                "Fresh receipt identity mismatch",
            )?;
            match progress.state.as_str() {
                "complete" => require(progress.completed_steps == 12, "Invalid local completion")?,
                "authorizing" => require(
                    progress.completed_steps == 0,
                    "Invalid local authorization receipt",
                )?,
                _ => validate_progress(plan, progress).map_err(|_| "Invalid remote progress")?,
            }
        }
    } else {
        require(
            entry.installation.is_none(),
            "Receipt without a native plan",
        )?;
    }
    Ok(entry)
}
fn peer_projection(mut registry: Value, environment: Option<&str>) -> OperatorResult<Value> {
    require(registry["version"] == 1, "Invalid registry version")?;
    let entries = registry["environments"]
        .as_object_mut()
        .ok_or("Invalid registry")?;
    if let Some(id) = environment {
        entries.remove(id);
    }
    Ok(registry)
}
fn setup_peer_projection(entries: &Value) -> OperatorResult<Value> {
    let mut peers = entries.as_object().ok_or("Invalid setup entries")?.clone();
    peers.remove(FRESH);
    Ok(Value::Object(peers))
}
fn preserved_setup_peers(entries: &Value, journal: &Value) -> OperatorResult<Value> {
    let restart: restart::Journal =
        serde_json::from_value(journal.clone()).map_err(|_| "Invalid native reset journal")?;
    let peers = setup_peer_projection(entries)?;
    for (id, raw) in peers.as_object().ok_or("Invalid setup peers")? {
        let mut entry: Entry = serde_json::from_value(raw.clone()).map_err(|_| {
            "Non-fresh setup schema is invalid or has unknown fields; initialization refused"
        })?;
        require(
            environments::validate_id(id).is_ok() && entry.id == *id,
            "Non-fresh setup identity is invalid; initialization refused",
        )?;
        entry
            .target
            .validate()
            .map_err(|_| "Non-fresh setup target is invalid")?;
        if let Some(plan) = &entry.plan {
            plan.validate()
                .map_err(|_| "Non-fresh installation plan is invalid")?;
        }
        if let Some(inspection) = &entry.inspection {
            inspection
                .validate()
                .map_err(|_| "Non-fresh inspection is invalid")?;
        }
        // Setup::new resets these phases before persisting the entire entries map.
        require(
            !matches!(
                entry.phase.as_str(),
                "inspecting" | "connecting" | "tunnel_ready"
            ),
            "Native initialization would interrupt a non-fresh setup; resolve it separately",
        )?;
        restart.project_entry(&mut entry);
        require(serde_json::to_value(&entry).map_err(|_| "Non-fresh setup encoding failed")? == *raw,
            "Native initialization or serialization would change a non-fresh setup; initialization refused")?;
    }
    Ok(peers)
}
fn verify_setup_peers(entries: &Value, expected: &Value) -> OperatorResult<()> {
    require(
        setup_peer_projection(entries)? == *expected,
        "Non-fresh setup records changed; stopping without repair",
    )
}
fn initialize_setup(root: &Path, expected_peers: &Value) -> OperatorResult<Setup> {
    let entries = document(root, "server-setup/entries.json")?;
    verify_setup_peers(&entries, expected_peers)?;
    preserved_setup_peers(&entries, &document(root, RESET_FILE)?)?;
    Setup::new(root.to_path_buf()).map_err(|_| "Native setup initialization failed")
}
struct Frozen {
    root: PathBuf,
    root_id: (u64, u64),
    reset: Vec<u8>,
    fences: Vec<u8>,
    setup_peers: Value,
    peers: Value,
    environment: Option<String>,
    device: (String, String),
}
impl Frozen {
    fn capture(root: &Path) -> OperatorResult<Self> {
        let root_id = owned_directory(root)?;
        for directory in [
            "server-setup",
            "server-setup/restart-recovery",
            "environments",
            "environments/restart-fences",
        ] {
            owned_directory(&root.join(directory))?;
        }
        let entries = document(root, "server-setup/entries.json")?;
        let reset = read_regular(&root.join(RESET_FILE), MAX_DOCUMENT, true)?;
        let journal = serde_json::from_slice(&reset).map_err(|_| "Invalid reset journal")?;
        let device = completed_reset(&journal, &entries)?;
        let setup_peers = preserved_setup_peers(&entries, &journal)?;
        let entry = fresh_entry(&entries, &device)?;
        let environment = entry.plan.as_ref().map(|plan| plan.environment_id.clone());
        let registry = document(root, "environments/registry.json")?;
        let canonical: environments::Metadata = serde_json::from_value(registry.clone())
            .map_err(|_| "Native registry schema is invalid")?;
        require(
            peer_projection(serde_json::to_value(canonical).map_err(|_| "Native registry encoding failed")?, environment.as_deref())?
                == peer_projection(registry.clone(), environment.as_deref())?,
            "Native registration would normalize peer metadata; review it separately before installation",
        )?;
        require(
            registry["environments"].get(OLD_ENVIRONMENT).is_none(),
            "Old environment has not been removed by native reset completion",
        )?;

        let fences = read_regular(&root.join(FENCES_FILE), MAX_DOCUMENT, true)?;
        let fence: Value = serde_json::from_slice(&fences).map_err(|_| "Invalid restart fences")?;
        require(
            fence["schemaVersion"] == 1
                && fence["environments"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&json!(OLD_ENVIRONMENT))),
            "Original environment fence missing",
        )?;
        for id in [FRESH, WORKING, SOURCE] {
            verify_pin(root, id)?;
        }
        Ok(Self {
            root: root.into(),
            root_id,
            reset,
            fences,
            setup_peers,
            peers: peer_projection(registry, environment.as_deref())?,
            environment,
            device,
        })
    }
    fn bind_environment(&mut self, id: &str) -> OperatorResult<()> {
        if let Some(current) = &self.environment {
            require(current == id, "Fresh environment changed")?;
        } else {
            require(
                self.peers["environments"].get(id).is_none(),
                "Generated environment collides with a peer",
            )?;
            self.environment = Some(id.into());
        }
        Ok(())
    }
    fn verify(&self) -> OperatorResult<Entry> {
        require(
            owned_directory(&self.root)? == self.root_id,
            "Native root replaced",
        )?;
        require(
            read_regular(&self.root.join(RESET_FILE), MAX_DOCUMENT, true)? == self.reset
                && read_regular(&self.root.join(FENCES_FILE), MAX_DOCUMENT, true)? == self.fences,
            "Original reset record or fences changed; stopping without repair",
        )?;
        let entries = document(&self.root, "server-setup/entries.json")?;
        verify_setup_peers(&entries, &self.setup_peers)?;
        require(
            peer_projection(
                document(&self.root, "environments/registry.json")?,
                self.environment.as_deref(),
            )? == self.peers,
            "Peer registry metadata changed; stopping without repair",
        )?;
        for id in [FRESH, WORKING, SOURCE] {
            verify_pin(&self.root, id)?;
        }
        let entry = fresh_entry(&entries, &self.device)?;
        if let Some(plan) = &entry.plan {
            require(
                self.environment
                    .as_deref()
                    .is_none_or(|id| id == plan.environment_id),
                "Fresh environment changed",
            )?;
        }
        Ok(entry)
    }
}
struct Bundle {
    manifest: Value,
    archive: PathBuf,
    manifest_bytes: Vec<u8>,
}
impl Bundle {
    fn load() -> OperatorResult<Self> {
        let root = Path::new(REPO).join("desktop/src-tauri/resources");
        let manifest_bytes = read_regular(&root.join("host-release.json"), 65536, false)?;
        let manifest: Value =
            serde_json::from_slice(&manifest_bytes).map_err(|_| "Invalid bundled manifest")?;
        require(
            manifest["id"] == RELEASE
                && manifest["sha256"] == ARCHIVE_SHA
                && manifest["size"] == ARCHIVE_SIZE
                && manifest["manifest"]["id"] == RELEASE
                && manifest["manifest"]["protocolVersion"] == 2,
            "Bundled release changed; a new code review is required",
        )?;
        let result = Self {
            manifest,
            archive: root.join("host-release.tar.gz"),
            manifest_bytes,
        };
        result.verify()?;
        Ok(result)
    }
    fn verify(&self) -> OperatorResult<()> {
        let bytes = read_regular(&self.archive, BROKER_LIMIT, false)?;
        require(
            bytes.len() as u64 == ARCHIVE_SIZE
                && format!("{:x}", Sha256::digest(&bytes)) == ARCHIVE_SHA
                && format!("{:x}", Sha256::digest(INSTALLER.as_bytes())) == INSTALLER_SHA
                && read_regular(
                    &Path::new(REPO).join("deploy/environment/host_install.py"),
                    BROKER_LIMIT,
                    false,
                )? == INSTALLER.as_bytes()
                && read_regular(
                    &self.archive.with_file_name("host-release.json"),
                    65536,
                    false,
                )? == self.manifest_bytes
                && read_regular(
                    &Path::new(REPO).join("scripts/outpost2_install_broker.py"),
                    BROKER_LIMIT,
                    false,
                )? == BRIDGE.as_bytes(),
            "Reviewed installer, archive, manifest or bridge changed",
        )
    }
}
fn broker_launch(
    entry: &Entry,
    source: &str,
    frame: &[u8],
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if entry.id != FRESH
        || entry.target != target()
        || entry.fingerprint != FINGERPRINT
        || source != INSTALLER
        || source.len() > BROKER_LIMIT
        || frame.len() > BROKER_LIMIT
        || entry.installation.is_some()
        || cancel.load(Ordering::SeqCst)
    {
        return Err("Broker dispatch refused before launch".into());
    }
    let packet = zeroize::Zeroizing::new(
        serde_json::to_vec(&json!({ "entry": entry,
        "source": STANDARD.encode(source), "frame": STANDARD.encode(frame) }))
        .map_err(|_| "Invalid broker frame")?,
    );
    run(
        "/usr/bin/python3",
        &[
            "-I".into(),
            "-B".into(),
            "-S".into(),
            format!("{REPO}/scripts/outpost2_install_broker.py"),
        ],
        &packet,
        Duration::from_secs(120),
        cancel,
    )
    .map_err(|_| "Broker outcome unknown; only poll this operation".into())
}
fn print_progress(progress: &InstallProgress) {
    let stages = [
        "Preflight",
        "Service accounts",
        "Private Node runtime",
        "Locked server dependencies",
        "Browser runtime",
        "Protected configuration",
        "Device enrollment",
        "Persistent services",
        "Health verification",
        "Server ready",
        "Private connection",
        "Authenticated registration",
        "Ready to use",
    ];
    println!(
        "{}",
        json!({"state": progress.state, "completedSteps": progress.completed_steps, "totalSteps": progress.total_steps,
        "stage": stages.get(usize::from(progress.completed_steps)).unwrap_or(&"Verification")})
    );
}
fn needs_launch(entry: &Entry) -> bool {
    entry.installation.is_none()
}
fn poll_ready(setup: &Setup, frozen: &Frozen, budget: Duration) -> OperatorResult<()> {
    let start = Instant::now();
    loop {
        require(
            start.elapsed().saturating_add(Duration::from_secs(24)) < budget,
            "Installation wait expired; rerun only to poll the saved operation, never launch again",
        )?;
        boundary()?;
        frozen.verify()?;
        match setup.install_status(FRESH, false) {
            Ok(entry) => {
                let progress = entry.installation.ok_or("Installation receipt missing")?;
                print_progress(&progress);
                if matches!(progress.state.as_str(), "ready" | "complete") {
                    return Ok(());
                }
                require(!matches!(progress.state.as_str(), "failed" | "cancelled" | "interrupted"),
                    "Fresh installation stopped; retained receipt requires separate review, no replay")?;
            }
            Err(_) => println!(
                "{}",
                json!({"state":"unknown", "stage":"Waiting for the same operation receipt"})
            ),
        }
        thread::sleep(
            budget
                .saturating_sub(start.elapsed())
                .min(Duration::from_secs(3)),
        );
    }
}
fn verify_health(
    environment: &Value,
    runtime: &Value,
    inventory: &Value,
    plan: &InstallPlan,
    manifest: &Value,
) -> OperatorResult<()> {
    require(
        environment["environmentId"] == plan.environment_id
            && environment["protocolVersion"] == 2
            && environment["supportedProtocolVersions"] == json!([2])
            && environment["legacyUnboundRequests"] == false
            && environment["runtime"]["release"] == plan.release_id
            && environment["services"]["worker"]["configured"] == true
            && environment["services"]["hostAdministration"]["configured"] == true,
        "Signed environment identity, release or configured services mismatch",
    )?;
    require(
        runtime["piManagement"] == true
            && runtime["configured"] == true
            && runtime["hostAdministration"] == true
            && runtime["browserEngine"] == "camoufox"
            && runtime["browserDirect"] == true
            && runtime["browserTakeover"] == true,
        "Signed runtime capabilities do not match approval",
    )?;
    require(
        inventory["releaseId"] == plan.release_id
            && inventory["manifest"] == manifest["manifest"]
            && inventory["piVersion"] == manifest["manifest"]["piVersion"]
            && inventory["extensions"] == manifest["manifest"]["extensions"],
        "Worker inventory does not match the reviewed bundle",
    )
}
struct CloseSetup(Arc<Setup>);
impl Drop for CloseSetup {
    fn drop(&mut self) {
        self.0.close();
    }
}

fn execute() -> OperatorResult<()> {
    boundary()?;
    let _lease = OperatorLease::acquire(Path::new(ROOT))?;
    let mut frozen = Frozen::capture(Path::new(ROOT))?;
    let bundle = Bundle::load()?;
    let mut state =
        State::new(PathBuf::from(ROOT)).map_err(|_| "Native identity state unavailable")?;
    state.identity_store = Some(environments::existing_keychain_identity());
    let device = public_identity(&state).map_err(|_| {
        "Existing Keychain identity unavailable without UI; no identity was created or replaced"
    })?;
    require(
        device == frozen.device,
        "Existing Keychain public identity differs from the original reset binding",
    )?;
    boundary()?;
    frozen.verify()?;
    let owned = CloseSetup(Arc::new(initialize_setup(
        Path::new(ROOT),
        &frozen.setup_peers,
    )?));
    let setup = &owned.0;
    let registry = environments::Registry::new(PathBuf::from(ROOT), state.mutation_gate())
        .map_err(|_| "Native registry initialization failed")?;
    require(
        setup.ssh_fixture.is_none() && !registry.fixture_identity,
        "Live native transport and existing Keychain identity required",
    )?;
    require(
        registry.restart_unfenced(OLD_ENVIRONMENT).is_err(),
        "Original environment fence missing",
    )?;
    let entry = frozen.verify()?;
    setup
        .restart_entry_allowed(FRESH)
        .map_err(|_| "Fresh entry is still fenced")?;
    if needs_launch(&entry) {
        boundary()?;
        bundle.verify()?;
        let planned = if entry.plan.is_some() {
            entry.clone()
        } else {
            setup
                .plan(FRESH, bundle.manifest.clone(), true, true, device.clone())
                .map_err(|_| "Native fresh planning failed; no launch requested")?
        };
        let plan = planned.plan.as_ref().ok_or("Native plan missing")?;
        frozen.bind_environment(&plan.environment_id)?;
        frozen.verify()?;
        let started = setup
            .start_install_with(
                FRESH,
                &plan.plan_id,
                true,
                true,
                bundle.archive.clone(),
                device,
                |entry, source, frame, cancel| {
                    boundary().map_err(str::to_string)?;
                    bundle.verify().map_err(str::to_string)?;
                    let current = frozen.verify().map_err(str::to_string)?;
                    if current.installation.as_ref().is_none_or(|p| {
                        p.state != "authorizing"
                            || p.operation_id
                                != entry.plan.as_ref().map_or("", |p| p.operation_id.as_str())
                    }) {
                        return Err("Native authorizing receipt changed".into());
                    }
                    broker_launch(entry, source, frame, cancel)
                },
            )
            .map_err(|_| {
                "Native launch not confirmed; retained state must only be polled, never replayed"
            })?;
        if let Some(progress) = &started.installation {
            print_progress(progress);
        }
    }
    let entry = frozen.verify()?;
    let plan = entry.plan.ok_or("Existing receipt has no native plan")?;
    frozen.bind_environment(&plan.environment_id)?;
    poll_ready(setup, &frozen, Duration::from_secs(1800))?;
    boundary()?;
    frozen.verify()?;
    tauri::async_runtime::block_on(async {
        let finished = setup
            .finish_install(&registry, FRESH)
            .await
            .map_err(|_| "Native finish/registration failed; do not reenroll or reinstall")?;
        require(
            finished
                .installation
                .as_ref()
                .is_some_and(|p| p.state == "complete" && p.completed_steps == 12),
            "Native completion missing",
        )?;
        frozen.verify()?;
        registry
            .attach_ssh(&plan.environment_id, FRESH, false)
            .map_err(|_| "Native route ownership not saved")?;
        let binding = registry
            .ssh_bindings()
            .map_err(|_| "Native route ownership unavailable")?
            .into_iter()
            .find(|(id, binding)| id == &plan.environment_id && binding.setup_id == FRESH)
            .ok_or("Fresh managed route missing")?
            .1;
        setup
            .recover_saved(&registry, &plan.environment_id, &binding)
            .await
            .map_err(|_| "Fresh managed route verification failed")?;
        let connection = registry
            .get(&plan.environment_id)
            .map_err(|_| "New environment unavailable")?;
        let environment = environments::query_value(&connection, "environment".into(), json!({}))
            .await
            .map_err(|_| "Signed environment verification failed")?;
        let runtime = environments::query_value(&connection, "runtime".into(), json!({}))
            .await
            .map_err(|_| "Signed runtime verification failed")?;
        let inventory = connection
            .agent_request(json!({"type":"runtime.inventory"}))
            .await
            .map_err(|_| "Signed worker verification failed")?;
        verify_health(&environment, &runtime, &inventory, &plan, &bundle.manifest)
    })?;
    frozen.verify()?;
    boundary()?;
    println!(
        "{}",
        json!({"state":"complete", "completedSteps":12, "totalSteps":12, "setupId":FRESH,
        "operationId":plan.operation_id, "environmentId":plan.environment_id, "releaseId":plan.release_id,
        "browserRenderingVerified":false})
    );
    Ok(())
}

#[test]
#[ignore = "LIVE fresh Outpost2 installation; exact SETUP/FRESH opt-ins, completed same reset, closed app and existing Keychain required; UI only with explicit KEYCHAIN_UI opt-in"]
fn outpost2_fresh_install_after_completed_reset() -> OperatorResult<()> {
    boundary()?; // No app-data, Keychain or broker access before exact opt-in and app guard.
    let _exclusive = INTERACTION_LOCK
        .lock()
        .map_err(|_| "Keychain interaction guard unavailable")?;
    match std::env::var_os("OUTPOST_OPERATOR_KEYCHAIN_UI").as_deref() {
        None => {
            let mut interaction = NoInteraction::enter(SecurityInteraction)?;
            let result = execute();
            let restored = interaction.restore();
            restored.and(result)
        }
        Some(value) if value == OsStr::new("1") => {
            require(
                SecurityInteraction.get()?,
                "macOS Keychain interaction is unavailable",
            )?;
            // The owner must approve the OS dialog; never collect or inject a Mac password.
            execute()
        }
        _ => Err("Invalid explicit Keychain interaction opt-in"),
    }
}

#[path = "server_setup_install_operator_tests.rs"]
mod nonlive;
