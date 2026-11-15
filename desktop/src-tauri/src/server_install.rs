//! Reviewed native installation. Passwords and release bytes never cross React IPC.
use super::*;
use tauri::Manager;

const INSTALLER: &str = include_str!("../../../deploy/environment/host_install.py");
#[cfg(test)]
#[path = "server_setup_install_finish_tests.rs"]
mod finish_tests;
#[cfg(test)]
#[path = "server_install_history_tests.rs"]
mod history_tests;
#[cfg(all(test, target_os = "macos"))]
#[path = "server_setup_install_operator.rs"]
mod operator;
#[cfg(test)]
#[path = "server_install_tests.rs"]
mod tests;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallPlan {
    pub(super) plan_id: String,
    pub(super) operation_id: String,
    pub(super) environment_id: String,
    pub(super) release_id: String,
    pub(super) sha256: String,
    pub(super) size: u64,
    expires_at: u64,
    browser: bool,
    #[serde(default)]
    full_control: bool,
    coexistence_required: bool,
    pub(super) device_id: String,
    pub(super) public_key: String,
    node_version: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallProgress {
    pub(super) operation_id: String,
    pub(super) environment_id: String,
    pub(super) release_id: String,
    pub(super) state: String,
    pub(super) completed_steps: u8,
    pub(super) total_steps: u8,
    pub(super) stage: String,
    started_at: u64,
    updated_at: u64,
    log: Vec<String>,
    error: Option<String>,
    // Runtime-only provenance keeps journal and IPC JSON readable by older bundles.
    #[serde(skip)]
    remote_updated_at: Option<u64>,
}
#[derive(Clone, Copy)]
enum InstallProgressSource {
    Local,
    Remote,
}
impl InstallProgress {
    pub(super) fn remote_timestamp(&self) -> Option<u64> {
        self.remote_updated_at.or_else(|| {
            // On reload only these states have a known remote clock. Persisted `unknown`
            // may use either clock: its first remote resolution cannot be time-ordered
            // against it and instead establishes a new runtime watermark. Identity and
            // completed-step guards still apply; no journal schema change is needed.
            match self.state.as_str() {
                "queued" | "running" | "ready" | "failed" | "cancelled" | "interrupted" => {
                    Some(self.updated_at)
                }
                _ => None,
            }
        })
    }
    fn same_operation(&self, other: &Self) -> bool {
        self.operation_id == other.operation_id
            && self.environment_id == other.environment_id
            && self.release_id == other.release_id
    }
}
impl InstallPlan {
    pub(super) fn validate(&self) -> Result<(), String> {
        for id in [
            &self.plan_id,
            &self.operation_id,
            &self.environment_id,
            &self.device_id,
        ] {
            environments::validate_id(id)?;
        }
        if self.sha256.len() != 64
            || !self.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || self.size == 0
            || self.size > 16 * 1024 * 1024
            || !self.release_id.starts_with("host-")
            || self.release_id.len() != 25
            || !self.release_id[5..].bytes().all(|c| c.is_ascii_hexdigit())
            || STANDARD
                .decode(&self.public_key)
                .map_or(true, |key| key.len() != 32)
        {
            return Err("Invalid persisted installation plan".into());
        }
        Ok(())
    }
}
pub(super) fn python(source: &str) -> String {
    format!(
        "/usr/bin/python3 -c 'import base64;exec(base64.b64decode(\"{}\"))'",
        STANDARD.encode(source)
    )
}
pub(super) fn resource(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|_| "App resources unavailable")?
        .join(name);
    if path.is_file() {
        return Ok(path);
    }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name);
        if development.is_file() {
            return Ok(development);
        }
    }
    Err("This app has no bundled host release. Rebuild with desktop:build.".into())
}
pub(super) fn public_identity(state: &State) -> Result<(String, String), String> {
    let mut client = state.client.lock().map_err(|_| "Identity lock failed")?;
    state.identity(&mut client)?;
    let identity = client
        .identity
        .as_ref()
        .ok_or("Device identity unavailable")?;
    Ok((
        identity.id.clone(),
        STANDARD.encode(identity.key.verifying_key().to_bytes()),
    ))
}
impl Setup {
    pub(super) fn entry(&self, id: &str) -> Result<Entry, String> {
        self.ready()?;
        self.inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .entries
            .get(id)
            .cloned()
            .ok_or("Unknown setup target".into())
    }
    fn store_install(
        &self,
        id: &str,
        mut progress: InstallProgress,
        source: InstallProgressSource,
    ) -> Result<Entry, String> {
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        Self::restart_allowed(&inner, inner.entries.get(id).ok_or("Unknown setup target")?)?;
        let entry = inner.entries.get_mut(id).ok_or("Unknown setup target")?;
        let plan = entry.plan.as_ref().ok_or("No installation plan")?;
        if progress.operation_id != plan.operation_id
            || progress.environment_id != plan.environment_id
            || progress.release_id != plan.release_id
            || entry
                .installation
                .as_ref()
                .is_some_and(|current| !current.same_operation(&progress))
        {
            return Err("Installation receipt does not match the approved operation".into());
        }
        match source {
            InstallProgressSource::Remote => {
                validate_progress(plan, &progress)?;
                // Learn provenance only from a validated remote receipt.
                progress.remote_updated_at = Some(progress.updated_at);
            }
            InstallProgressSource::Local => {
                if progress.total_steps != 12
                    || !matches!(
                        (progress.state.as_str(), progress.completed_steps),
                        ("authorizing" | "unknown", 0) | ("complete", 12)
                    )
                {
                    return Err("Invalid local installation progress".into());
                }
                progress.remote_updated_at = entry
                    .installation
                    .as_ref()
                    .and_then(InstallProgress::remote_timestamp);
            }
        }
        if history::active_install_state(&progress.state) {
            // Visibility follows even a conservatively rejected active observation.
            self.reveal_history(id)?;
        }
        if let Some(current) = &entry.installation {
            if current.state == "complete"
                || (current.state == "ready" && progress.state != "complete")
                || progress.completed_steps < current.completed_steps
            {
                return Ok(entry.clone());
            }
            if let Some(remote_updated_at) = current.remote_timestamp() {
                match source {
                    InstallProgressSource::Local if progress.state != "complete" => {
                        // A late launch error/retry must not erase an observed host receipt.
                        return Ok(entry.clone());
                    }
                    InstallProgressSource::Remote => {
                        let stopped = matches!(
                            current.state.as_str(),
                            "failed" | "cancelled" | "interrupted"
                        );
                        if progress.updated_at < remote_updated_at
                            || (stopped && progress.updated_at == remote_updated_at)
                        {
                            // Interrupted is inferred using the last remote timestamp. Recovery
                            // needs a newer receipt, not an older in-flight liveness result.
                            return Ok(entry.clone());
                        }
                        if progress.updated_at == remote_updated_at
                            && progress.completed_steps == current.completed_steps
                            && (progress.state == current.state
                                || (current.state == "running"
                                    && matches!(progress.state.as_str(), "queued" | "unknown")))
                        {
                            return Ok(entry.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        if progress.state == "complete"
            && !entry
                .installation
                .as_ref()
                .is_some_and(|current| current.state == "ready")
        {
            return Err("The installation is not ready for connection".into());
        }
        entry.phase = match progress.state.as_str() {
            "ready" => "installed",
            "complete" => "tunnel_ready",
            "failed" | "cancelled" | "interrupted" => "installation_stopped",
            _ => "installing",
        }
        .into();
        entry.installation = Some(progress);
        let result = entry.clone();
        self.persist(&inner)?;
        Ok(result)
    }
    fn plan(
        &self,
        id: &str,
        manifest: Value,
        browser: bool,
        full_control: bool,
        device: (String, String),
    ) -> Result<Entry, String> {
        if self.entry(id)?.installation.is_some() {
            return Err("An installation receipt already exists. Check its status; do not start a second installation.".into());
        }
        let mut entry = self.inspect(id)?;
        let found = entry.inspection.as_ref().ok_or("Inspection missing")?;
        if found.native_present {
            return Err("Native installation files already exist. Connect the installation or review its original setup receipt; fresh installation is blocked.".into());
        }
        if found.os != "ubuntu"
            || found.architecture != "x86_64"
            || !found.systemd
            || found.container
            || found
                .os_version
                .split('.')
                .next()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0)
                < 24
        {
            return Err("Installation requires Ubuntu 24.04 or later, x86_64, systemd, and Python 3.12+ on the host.".into());
        }
        if found.free_bytes < 10 * 1024 * 1024 * 1024
            || found.memory_bytes < (if browser { 3 } else { 2 }) * 1024 * 1024 * 1024
        {
            return Err("At least 10 GiB free disk and 2 GiB usable RAM are required; browser installation requires 3 GiB usable RAM (normally a 4 GiB host).".into());
        }
        let plan = InstallPlan {
            plan_id: Uuid::new_v4().to_string(),
            operation_id: Uuid::new_v4().to_string(),
            environment_id: Uuid::new_v4().to_string(),
            release_id: manifest["id"]
                .as_str()
                .ok_or("Invalid bundled release")?
                .into(),
            sha256: manifest["sha256"]
                .as_str()
                .ok_or("Invalid bundled digest")?
                .into(),
            size: manifest["size"].as_u64().ok_or("Invalid bundled size")?,
            expires_at: now() + 300_000,
            browser,
            full_control,
            coexistence_required: !found.markers.is_empty() || found.api != "absent",
            device_id: device.0,
            public_key: device.1,
            node_version: manifest["nodeVersion"]
                .as_str()
                .ok_or("Invalid private Node version")?
                .into(),
        };
        plan.validate()?;
        entry.plan = Some(plan);
        entry.phase = "install_review".into();
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        inner.entries.insert(id.into(), entry.clone());
        self.persist(&inner)?;
        Ok(entry)
    }
    fn start_install(
        &self,
        id: &str,
        plan_id: &str,
        approved: bool,
        coexistence: bool,
        password: bool,
        archive: PathBuf,
        device: (String, String),
    ) -> Result<Entry, String> {
        self.start_install_with(
            id,
            plan_id,
            approved,
            coexistence,
            archive,
            device,
            |entry, source, frame, cancel| {
                self.launch_install(entry, source, frame, password, cancel)
            },
        )
    }
    fn start_install_with(
        &self,
        id: &str,
        plan_id: &str,
        approved: bool,
        coexistence: bool,
        archive: PathBuf,
        device: (String, String),
        launch: impl FnOnce(&Entry, &str, &[u8], &AtomicBool) -> Result<Vec<u8>, String>,
    ) -> Result<Entry, String> {
        let ownership = self.activity(id, history::ActivityKind::Installation)?;
        let entry = ownership.entry.clone();
        let cancel = ownership.cancel.clone();
        self.inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .running
            .insert(id.into(), cancel.clone());
        let result = (|| {
            let plan = entry
                .plan
                .as_ref()
                .ok_or("Review the installation plan first")?;
            plan.validate()?;
            if !approved
                || plan.plan_id != plan_id
                || (entry.installation.is_none() && now() > plan.expires_at)
                || (plan.coexistence_required && !coexistence)
            {
                return Err("Installation approval does not match a current reviewed plan.".into());
            }
            if device != (plan.device_id.clone(), plan.public_key.clone()) {
                return Err("The installing Mac's identity changed. Installation blocked.".into());
            }
            if entry
                .installation
                .as_ref()
                .is_some_and(|p| !["unknown", "authorizing"].contains(&p.state.as_str()))
            {
                return Err("This installation already has a receipt. Check status rather than starting again.".into());
            }
            if fs::metadata(&archive)
                .map_err(|_| "Bundled release unavailable")?
                .len()
                != plan.size
                || plan.size > 16 * 1024 * 1024
            {
                return Err("Bundled release size mismatch".into());
            }
            let payload = fs::read(archive).map_err(|_| "Bundled release unreadable")?;
            let actual = Sha256::digest(&payload)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            if actual != plan.sha256 {
                return Err("Bundled release checksum mismatch; installation blocked.".into());
            }
            let initial = InstallProgress {
                operation_id: plan.operation_id.clone(),
                environment_id: plan.environment_id.clone(),
                release_id: plan.release_id.clone(),
                state: "authorizing".into(),
                completed_steps: 0,
                total_steps: 12,
                stage: "Authorize installation".into(),
                started_at: now(),
                updated_at: now(),
                log: vec![
                    if plan.full_control {
                        "Reviewed installation approved with ongoing full server control through the authenticated root executor."
                    } else {
                        "Reviewed restricted installation approved. No ongoing root authority is granted."
                    }.into(),
                ],
                error: None,
                remote_updated_at: None,
            };
            self.store_install(id, initial.clone(), InstallProgressSource::Local)?;
            let request = json!({ "operationId": plan.operation_id, "environmentId": plan.environment_id, "deviceId": plan.device_id, "publicKey": plan.public_key,
                "label": entry.label, "releaseId": plan.release_id, "sha256": plan.sha256, "size": plan.size, "browser": plan.browser, "coexistence": coexistence, "fullControl": plan.full_control });
            let mut frame = zeroize::Zeroizing::new(
                serde_json::to_vec(&request).map_err(|_| "Invalid installation packet")?,
            );
            frame.push(b'\n');
            frame.extend(payload);
            self.ready()?;
            {
                let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
                let current = inner.entries.get(id).ok_or("Unknown setup target")?;
                Self::restart_allowed(&inner, current)?;
                if cancel.load(Ordering::SeqCst)
                    || !inner
                        .activities
                        .get(id)
                        .is_some_and(|activity| activity.token == ownership.token)
                    || current.target != entry.target
                    || current.fingerprint != entry.fingerprint
                    || serde_json::to_value(&current.plan).map_err(|_| "Invalid current plan")?
                        != serde_json::to_value(&entry.plan).map_err(|_| "Invalid approved plan")?
                {
                    return Err(
                        "Installation no longer owns its reviewed target; launch blocked.".into(),
                    );
                }
            }
            let response = launch(&entry, INSTALLER, &frame, &cancel);
            frame.fill(0);
            let progress = response.and_then(|bytes| serde_json::from_slice::<InstallProgress>(&bytes).map_err(|_| "Installation launch reply was incomplete. Check status; do not assume nothing ran.".into()));
            match progress {
                Ok(progress) => {
                    validate_progress(plan, &progress)?;
                    self.store_install(id, progress, InstallProgressSource::Remote)
                }
                Err(_) => {
                    let mut progress = initial;
                    progress.state = "unknown".into();
                    progress.error = Some("Authorization or launch was not confirmed. Check remote status. An explicit retry uses the same operation ID and cannot start a duplicate job.".into());
                    self.store_install(id, progress, InstallProgressSource::Local)
                }
            }
        })();
        self.inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .running
            .remove(id);
        result
    }
    fn launch_install(
        &self,
        entry: &Entry,
        source: &str,
        frame: &[u8],
        password: bool,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>, String> {
        let plan = entry.plan.as_ref().ok_or("No installation plan")?;
        let mut input = zeroize::Zeroizing::new(Vec::new());
        let needs_password = password
            && !entry
                .inspection
                .as_ref()
                .is_some_and(|value| value.uid == 0);
        if needs_password {
            let authority = if plan.full_control {
                "This installs ongoing full server control, including root access to all host files, Docker and services."
            } else {
                "This installs a restricted workspace without ongoing root access."
            };
            let prompt = format!(
                "Enter the sudo password for {}@{}:{}. It is not saved. {authority}",
                entry.target.user, entry.target.host, entry.target.port
            );
            let quoted =
                serde_json::to_string(&prompt).map_err(|_| "Invalid authorization target")?;
            let script = format!("text returned of (display dialog {quoted} default answer \"\" with hidden answer buttons {{\"Cancel\", \"Authorize installation\"}} default button \"Authorize installation\" with title \"Outpost server setup\")");
            let mut secret = zeroize::Zeroizing::new(
                run(
                    "/usr/bin/osascript",
                    &["-e".into(), script],
                    b"",
                    Duration::from_secs(180),
                    cancel,
                )
                .map_err(|_| {
                    "Authorization cancelled. Check setup status before explicitly trying again."
                })?,
            );
            while secret.last() == Some(&b'\n') || secret.last() == Some(&b'\r') {
                secret.pop();
            }
            if secret.is_empty() || secret.len() > 1024 || secret.contains(&b'\n') {
                return Err("Invalid or empty authorization input".into());
            }
            input.extend_from_slice(&secret);
            input.push(b'\n');
        }
        input.extend_from_slice(frame);
        let mut args = self.ssh_args(entry)?;
        let authorization = if entry
            .inspection
            .as_ref()
            .is_some_and(|value| value.uid == 0)
        {
            ""
        } else if password {
            "sudo -k -S -p '' -- "
        } else {
            "sudo -n -- "
        };
        args.extend([
            "--".into(),
            entry.target.host.clone(),
            format!("{authorization}{} --bootstrap", python(source)),
        ]);
        run(
            self.ssh_program(),
            &args,
            &input,
            Duration::from_secs(90),
            cancel,
        )
    }
    fn install_status(&self, id: &str, request_cancel: bool) -> Result<Entry, String> {
        self.restart_entry_allowed(id)?;
        let entry = self.entry(id)?;
        let progress = self.read_install_status(&entry, request_cancel)?;
        self.store_install(id, progress, InstallProgressSource::Remote)
    }
    pub(super) fn read_install_status(
        &self,
        entry: &Entry,
        request_cancel: bool,
    ) -> Result<InstallProgress, String> {
        let plan = entry.plan.as_ref().ok_or("No installation plan")?;
        plan.validate()?;
        if entry.installation.is_none() {
            return Err("No installation has been requested".into());
        }
        let mut args = self.ssh_args(&entry)?;
        let source = format!(
            r#"import json,pathlib,subprocess,time
p=pathlib.Path('/var/lib/outpost-setup/operations/{}')
{}
value={{'missing':True}}
if (p/'status.json').is_file():
    with (p/'status.json').open() as f:
        value=json.loads(f.read(65536))
    if value.get('state')=='queued' and (p/'launch.json').is_file():
        launched=json.loads((p/'launch.json').read_text())
        if launched.get('returnCode'):
            value['state']='unknown'
            value['error']='Setup service launch was not confirmed. Check the retained launch.log; no new operation was started.'
    if value.get('state') in ('running','queued','unknown') and time.time()*1000-value.get('updatedAt',0)>60000:
        result=subprocess.run(['/usr/bin/systemctl','is-active','--quiet','outpost-setup-'+p.name],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3)
        if result.returncode:
            value['state']='interrupted'
            value['error']='The setup service is no longer running. Partial changes may exist. Inspect this operation before recovery; it was not restarted.'
print(json.dumps(value))"#,
            plan.operation_id,
            if request_cancel {
                "(p/'cancel').write_text('1') if p.is_dir() else None"
            } else {
                "pass"
            }
        );
        args.extend(["--".into(), entry.target.host.clone(), python(&source)]);
        let bytes = run(
            self.ssh_program(),
            &args,
            b"",
            Duration::from_secs(15),
            &AtomicBool::new(false),
        )?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid installation status reply")?;
        if value["missing"] == true {
            return Err("No remote receipt is visible yet. Authorization may have failed. Retry only the same reviewed operation, or ask the server administrator to inspect it.".into());
        }
        let progress: InstallProgress =
            serde_json::from_value(value).map_err(|_| "Invalid installation receipt")?;
        validate_progress(plan, &progress)?;
        Ok(progress)
    }
}
fn validate_progress(plan: &InstallPlan, progress: &InstallProgress) -> Result<(), String> {
    if progress.operation_id != plan.operation_id
        || progress.environment_id != plan.environment_id
        || progress.release_id != plan.release_id
        || progress.total_steps != 12
        || progress.completed_steps > 10
        || ![
            "queued",
            "unknown",
            "running",
            "ready",
            "failed",
            "cancelled",
            "interrupted",
        ]
        .contains(&progress.state.as_str())
        || progress.state == "ready" && progress.completed_steps != 10
        || progress.stage.len() > 100
        || progress.log.len() > 80
        || progress.log.iter().any(|line| line.len() > 600)
        || progress
            .error
            .as_ref()
            .is_some_and(|error| error.len() > 600)
    {
        return Err("Installation receipt does not match the approved operation".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn setup_plan(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    state: tauri::State<'_, State>,
    id: String,
    browser: bool,
    full_control: bool,
) -> Result<Entry, String> {
    let manifest: Value = serde_json::from_slice(
        &fs::read(resource(&app, "host-release.json")?).map_err(|_| "Release manifest missing")?,
    )
    .map_err(|_| "Invalid release manifest")?;
    let device = public_identity(&state)?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        setup.plan(&id, manifest, browser, full_control, device)
    })
    .await
    .map_err(|_| "Plan inspection interrupted")?
}
#[tauri::command]
pub async fn setup_install(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    state: tauri::State<'_, State>,
    id: String,
    plan_id: String,
    approved: bool,
    coexistence: bool,
    password: bool,
) -> Result<Entry, String> {
    let archive = resource(&app, "host-release.tar.gz")?;
    let device = public_identity(&state)?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        setup.start_install(
            &id,
            &plan_id,
            approved,
            coexistence,
            password,
            archive,
            device,
        )
    })
    .await
    .map_err(|_| "Setup launch interrupted; check status")?
}
#[tauri::command]
pub async fn setup_install_status(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<Entry, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || setup.install_status(&id, false))
        .await
        .map_err(|_| "Status read interrupted")?
}
#[tauri::command]
pub async fn setup_install_cancel(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<Entry, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || setup.install_status(&id, true))
        .await
        .map_err(|_| "Cancellation not confirmed; check status")?
}
fn connection_identity_matches(progress: &InstallProgress, environment: &Environment) -> bool {
    environment.environment_id == progress.environment_id
        && (progress.state == "complete"
            || environment.release.as_deref() == Some(progress.release_id.as_str()))
}

#[tauri::command]
pub async fn setup_finish(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    id: String,
) -> Result<Entry, String> {
    setup.inner().finish_install(&registry, &id).await
}

impl Setup {
    async fn finish_install(
        self: &Arc<Self>,
        registry: &environments::Registry,
        id: &str,
    ) -> Result<Entry, String> {
        self.restart_entry_allowed(id)?;
        let copy = self.clone();
        let key = id.to_string();
        let entry = tauri::async_runtime::spawn_blocking(move || copy.install_status(&key, false))
            .await
            .map_err(|_| "Status read interrupted")??;
        let mut progress = entry.installation.ok_or("No installation receipt")?;
        if !["ready", "complete"].contains(&progress.state.as_str()) {
            return Err("The installation is not ready for connection".into());
        }
        for (environment, binding) in registry.ssh_bindings()? {
            if binding.setup_id == id {
                registry.ssh_policy(&environment, false)?;
            }
        }
        self.resume_route(id)?;
        if entry.endpoint.is_none() {
            let copy = self.clone();
            let key = id.to_string();
            let inspected = tauri::async_runtime::spawn_blocking(move || copy.inspect(&key))
                .await
                .map_err(|_| "Verification interrupted")??;
            if inspected
                .inspection
                .as_ref()
                .and_then(|i| i.environment.as_ref())
                .is_none_or(|environment| !connection_identity_matches(&progress, environment))
            {
                return Err(
                    "Installed environment identity or release does not match its creation receipt"
                        .into(),
                );
            }
            self.tunnel(id).await?;
        }
        let connected = self.entry(id)?;
        registry
            .register_created(
                progress.environment_id.clone(),
                connected.endpoint.ok_or("Private route missing")?,
                connected.label,
            )
            .await?;
        progress.state = "complete".into();
        progress.completed_steps = 12;
        progress.stage = "Ready to use".into();
        progress.updated_at = now();
        progress.log.push("This Mac's signed enrollment verified. Independent environment saved; old environment retained.".into());
        progress.error = None;
        self.store_install(id, progress, InstallProgressSource::Local)
    }
}
