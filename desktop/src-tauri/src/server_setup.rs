//! Read-only SSH preflight and owned loopback routes. No installer or arbitrary remote command IPC.
use super::*;
use std::{
    collections::BTreeMap,
    io::{BufRead, Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Instant,
};

#[path = "server_diagnostics.rs"]
pub mod diagnostics;
#[path = "server_history.rs"]
pub mod history;
#[path = "server_install.rs"]
pub mod install;
#[path = "server_lifecycle.rs"]
pub mod lifecycle;
#[path = "server_reboot.rs"]
pub mod reboot;
#[path = "server_restart.rs"]
pub mod restart;
#[path = "server_terminal.rs"]
pub mod terminal;
#[path = "server_update.rs"]
pub mod update;
pub use update::automatic as auto_update;

fn default_api_port() -> u16 {
    4318
}
const INSPECT: &str = include_str!("../../../deploy/environment/preflight.py");
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub identity_file: Option<String>,
}
impl Target {
    fn validate(&self) -> Result<(), String> {
        if self.port == 0
            || self.user.is_empty()
            || self.user.len() > 64
            || !self
                .user
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            || self.user.starts_with('-')
        {
            return Err("Enter a valid SSH user and port (1–65535).".into());
        }
        let host = self.host.as_str();
        if host.is_empty()
            || host.len() > 253
            || host.starts_with('-')
            || !(host.parse::<std::net::IpAddr>().is_ok()
                || host
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c)))
        {
            return Err(
                "Enter a hostname or IP address, without shell syntax, SSH options or a URL."
                    .into(),
            );
        }
        if let Some(path) = &self.identity_file {
            if path.contains(['\n', '\r', '\0']) || !std::path::Path::new(path).is_absolute() {
                return Err(
                    "Select an absolute private-key file path, or use the SSH agent.".into(),
                );
            }
        }
        Ok(())
    }
    fn check_key(&self) -> Result<(), String> {
        if let Some(path) = &self.identity_file {
            let metadata =
                fs::symlink_metadata(path).map_err(|_| "SSH identity file is not readable")?;
            if !metadata.is_file() {
                return Err("SSH identity must be a regular file.".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err("Private-key permissions must exclude group and other users (for example 0600).".into());
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    environment_id: String,
    release: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inspection {
    version: u8,
    os: String,
    os_version: String,
    architecture: String,
    systemd: bool,
    uid: u32,
    free_bytes: u64,
    memory_bytes: u64,
    markers: Vec<String>,
    container: bool,
    sudo: String,
    api: String,
    environment: Option<Environment>,
    #[serde(default = "default_api_port")]
    api_port: u16,
    #[serde(default)]
    native_present: bool,
}
impl Inspection {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.markers.len() > 32
            || self.markers.iter().any(|s| s.len() > 120)
            || [
                &self.os,
                &self.os_version,
                &self.architecture,
                &self.sudo,
                &self.api,
            ]
            .iter()
            .any(|s| s.len() > 80 || s.chars().any(char::is_control))
        {
            return Err("Unsupported host inspection response.".into());
        }
        if let Some(environment) = &self.environment {
            environments::validate_id(&environment.environment_id)?;
            if environment.release.as_ref().is_some_and(|r| {
                r.len() > 128
                    || !r
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            }) {
                return Err("Invalid runtime release identifier".into());
            }
        }
        Ok(())
    }
    fn recommendation(&self) -> &'static str {
        if self.container
            || self.markers.iter().any(|s| {
                s.contains("k3s")
                    || s.contains("pi-workspace")
                    || [
                        "home/node/.outpost",
                        "etc/kubernetes",
                        "var/lib/kubelet",
                        "var/lib/docker",
                        "var/lib/containerd",
                    ]
                    .contains(&s.as_str())
            })
        {
            return "migration_review";
        }
        if self.api == "environment" && self.environment.is_some() {
            return "connect_existing";
        }
        if self.api != "absent" || !self.markers.is_empty() {
            return "ambiguous_installation";
        }
        if self.os != "ubuntu" || self.architecture != "x86_64" || !self.systemd {
            return "unsupported_host";
        }
        if self.free_bytes < 10 * 1024 * 1024 * 1024 || self.memory_bytes < 2 * 1024 * 1024 * 1024 {
            return "insufficient_capacity";
        }
        "fresh_install_candidate"
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    id: String,
    label: String,
    target: Target,
    fingerprint: String,
    phase: String,
    inspection: Option<Inspection>,
    recommendation: Option<String>,
    endpoint: Option<String>,
    error: Option<String>,
    log: Vec<String>,
    #[serde(default)]
    plan: Option<install::InstallPlan>,
    #[serde(default)]
    installation: Option<install::InstallProgress>,
    #[serde(default)]
    connection_paused: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    id: String,
    target: Target,
    fingerprint: String,
}
struct Challenge {
    scan: Scan,
    key: String,
    created: Instant,
}
// Every early return also reaps the owned process; dropping std::process::Child alone does not.
struct OwnedChild(Child);
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Inner {
    entries: BTreeMap<String, Entry>,
    challenges: BTreeMap<String, Challenge>,
    tunnels: BTreeMap<String, OwnedChild>,
    running: BTreeMap<String, Arc<AtomicBool>>,
    recovering: BTreeMap<String, Arc<tokio::sync::Mutex<()>>>,
    activities: BTreeMap<String, history::Activity>,
    diagnostic_cache: Vec<diagnostics::CachedReport>,
    restart_reviews: Vec<restart::CachedReview>,
    restart_journal: restart::Journal,
}
pub struct Setup {
    directory: PathBuf,
    inner: Arc<Mutex<Inner>>,
    failure: Option<String>,
    closed: AtomicBool,
    wake_generation: AtomicU64,
    #[cfg(test)]
    ssh_fixture: Option<String>,
}
impl Setup {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let directory = root.join("server-setup");
        let fresh = durable_directory(&directory)?;
        let restart_journal = restart::Journal::load(&directory)?;
        let path = directory.join("entries.json");
        let mut entries: BTreeMap<String, Entry> = if fresh {
            BTreeMap::new()
        } else {
            serde_json::from_slice(
                &fs::read(&path)
                    .map_err(|_| "Cannot read setup journal; automatic recovery is blocked")?,
            )
            .map_err(|_| "Invalid setup journal")?
        };
        for (id, entry) in &mut entries {
            environments::validate_id(id)?;
            if &entry.id != id {
                return Err("Setup journal identity mismatch".into());
            }
            entry.target.validate()?;
            if let Some(plan) = &entry.plan {
                plan.validate()?;
            }
            if let Some(inspection) = &entry.inspection {
                inspection.validate()?;
            }
            if ["inspecting", "connecting", "tunnel_ready"].contains(&entry.phase.as_str()) {
                entry.phase = "interrupted".into();
                entry.endpoint = None;
                entry.error = Some("Desktop restarted. Saved trusted SSH connections will be restored automatically; no installation step was repeated.".into());
            }
            restart_journal.project_entry(entry);
        }
        private_write(
            &path,
            &serde_json::to_vec(&entries).map_err(|e| e.to_string())?,
        )?;
        Ok(Self {
            directory,
            failure: None,
            closed: AtomicBool::new(false),
            wake_generation: AtomicU64::new(0),
            #[cfg(test)]
            ssh_fixture: None,
            inner: Arc::new(Mutex::new(Inner {
                entries,
                challenges: BTreeMap::new(),
                tunnels: BTreeMap::new(),
                running: BTreeMap::new(),
                recovering: BTreeMap::new(),
                activities: BTreeMap::new(),
                diagnostic_cache: Vec::new(),
                restart_reviews: Vec::new(),
                restart_journal,
            })),
        })
    }
    pub fn unavailable(root: PathBuf, error: String) -> Self {
        Self {
            directory: root.join("server-setup"),
            failure: Some(error),
            closed: AtomicBool::new(false),
            wake_generation: AtomicU64::new(0),
            #[cfg(test)]
            ssh_fixture: None,
            inner: Arc::new(Mutex::new(Inner {
                entries: BTreeMap::new(),
                challenges: BTreeMap::new(),
                tunnels: BTreeMap::new(),
                running: BTreeMap::new(),
                recovering: BTreeMap::new(),
                activities: BTreeMap::new(),
                diagnostic_cache: Vec::new(),
                restart_reviews: Vec::new(),
                restart_journal: restart::Journal::default(),
            })),
        }
    }
    fn ssh_program(&self) -> &str {
        #[cfg(test)]
        if let Some(path) = &self.ssh_fixture {
            return path;
        }
        "/usr/bin/ssh"
    }
    fn ready(&self) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Desktop connection supervisor is stopping".into());
        }
        if let Some(error) = &self.failure {
            Err(error.clone())
        } else {
            Ok(())
        }
    }
    fn persist(&self, inner: &Inner) -> Result<(), String> {
        self.ready()?;
        private_write(
            &self.directory.join("entries.json"),
            &serde_json::to_vec(&inner.entries).map_err(|e| e.to_string())?,
        )
    }
    fn export_log(&self, id: &str, downloads: &std::path::Path) -> Result<String, String> {
        environments::validate_id(id)?;
        let entry = self.entry(id)?;
        if entry.id != id {
            return Err("Setup journal identity mismatch".into());
        }
        let report = setup_log_text(&entry)?;
        let directory = setup_log_directory(downloads)?;
        let label: String = entry
            .label
            .chars()
            .take(48)
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        let label = label.trim_matches('-');
        let label = if label.is_empty() { "server" } else { label };
        let path = directory.join(format!(
            "outpost-setup-{label}-{}-{}.txt",
            now(),
            Uuid::new_v4()
        ));
        private_setup_log_write(&path, report.as_bytes())?;
        Ok(path.to_string_lossy().into_owned())
    }
    fn record(&self, id: &str, phase: &str, message: &str) -> Result<Entry, String> {
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let entry = inner.entries.get_mut(id).ok_or("Unknown setup target")?;
        entry.phase = phase.into();
        entry.log.push(message.into());
        if entry.log.len() > 100 {
            entry.log.remove(0);
        }
        entry.error = if phase == "failed" || phase == "interrupted" {
            Some(message.into())
        } else {
            None
        };
        let result = entry.clone();
        self.persist(&inner)?;
        Ok(result)
    }
    fn alias(id: &str) -> String {
        format!("outpost-setup-{id}")
    }
    fn ssh_args(&self, entry: &Entry) -> Result<Vec<String>, String> {
        entry.target.check_key()?;
        self.pinned_ssh_args(entry)
    }
    fn pinned_ssh_args(&self, entry: &Entry) -> Result<Vec<String>, String> {
        environments::validate_id(&entry.id)?;
        entry.target.validate()?;
        let pin = self.directory.join(format!("{}.known_hosts", entry.id));
        let content = fs::read_to_string(&pin)
            .map_err(|_| "Pinned host key is missing; connection blocked")?;
        let (_, fingerprint) = parse_key(&content)?;
        if fingerprint != entry.fingerprint
            || !content.starts_with(&format!("{} ", Self::alias(&entry.id)))
        {
            return Err("Pinned host key changed; connection blocked".into());
        }
        let pin_path = pin.to_str().ok_or("Unsupported host-key storage path")?;
        if pin_path.contains(['\r', '\n', '"', '\\']) {
            return Err("Unsupported host-key storage path".into());
        }
        // -o parses ssh_config syntax even inside one argv item. Application Support contains a space.
        let known_hosts = format!("-oUserKnownHostsFile=\"{}\"", pin_path.replace('%', "%%"));
        let mut args = vec![
            "-F".into(),
            "/dev/null".into(),
            "-T".into(),
            "-oBatchMode=yes".into(),
            "-oStrictHostKeyChecking=yes".into(),
            "-oGlobalKnownHostsFile=/dev/null".into(),
            "-oUpdateHostKeys=no".into(),
            "-oForwardAgent=no".into(),
            "-oForwardX11=no".into(),
            "-oPermitLocalCommand=no".into(),
            "-oControlMaster=no".into(),
            "-oConnectTimeout=10".into(),
            "-oServerAliveInterval=10".into(),
            "-oServerAliveCountMax=3".into(),
            known_hosts,
            format!("-oHostKeyAlias={}", Self::alias(&entry.id)),
            "-p".into(),
            entry.target.port.to_string(),
            "-l".into(),
            entry.target.user.clone(),
        ];
        if let Some(path) = &entry.target.identity_file {
            args.extend(["-oIdentitiesOnly=yes".into(), "-i".into(), path.clone()]);
        }
        Ok(args)
    }
    fn begin(&self, id: &str) -> Result<(Entry, Arc<AtomicBool>), String> {
        self.ready()?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let entry = inner.entries.get(id).ok_or("Unknown setup target")?.clone();
        Self::restart_allowed(&inner, &entry)?;
        if history::activity_busy(&inner, &entry)
            || inner.running.contains_key(id)
            || inner.tunnels.contains_key(id)
        {
            return Err("This target already has a connection operation or diagnostic read. Wait for it to finish; disconnect an existing route before reinspection.".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inner.running.insert(id.into(), cancel.clone());
        Ok((entry, cancel))
    }
    fn scan(&self, target: Target) -> Result<Scan, String> {
        self.ready()?;
        target.validate()?;
        target.check_key()?;
        let output = run(
            "/usr/bin/ssh-keyscan",
            &[
                "-T".into(),
                "5".into(),
                "-p".into(),
                target.port.to_string(),
                "-t".into(),
                "ed25519".into(),
                target.host.clone(),
            ],
            b"",
            Duration::from_secs(12),
            &AtomicBool::new(false),
        )?;
        let (key, fingerprint) =
            parse_key(&String::from_utf8(output).map_err(|_| "Invalid SSH host key")?)?;
        let scan = Scan {
            id: Uuid::new_v4().to_string(),
            target,
            fingerprint,
        };
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        inner
            .challenges
            .retain(|_, challenge| challenge.created.elapsed() < Duration::from_secs(300));
        if inner.challenges.len() >= 16 {
            return Err("Too many pending host checks; wait for them to expire".into());
        }
        if inner.entries.values().any(|entry| {
            entry.target.host == scan.target.host
                && entry.target.port == scan.target.port
                && entry.fingerprint != scan.fingerprint
        }) {
            return Err("HOST KEY CHANGED. Stop and verify the server through an independent trusted channel. The saved key was not replaced.".into());
        }
        inner.challenges.insert(
            scan.id.clone(),
            Challenge {
                scan: scan.clone(),
                key,
                created: Instant::now(),
            },
        );
        Ok(scan)
    }
    fn trust(&self, id: String, fingerprint: String, label: String) -> Result<Entry, String> {
        self.ready()?;
        if label.trim() != label
            || label.is_empty()
            || label.len() > 80
            || label.chars().any(char::is_control)
        {
            return Err("Use a label of 1–80 printable characters".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let challenge = inner
            .challenges
            .remove(&id)
            .ok_or("Host check expired; scan again")?;
        if challenge.created.elapsed() >= Duration::from_secs(300)
            || fingerprint != challenge.scan.fingerprint
        {
            return Err("Fingerprint confirmation does not match this host check".into());
        }
        if inner.entries.values().any(|entry| {
            entry.target.host == challenge.scan.target.host
                && entry.target.port == challenge.scan.target.port
                && entry.fingerprint != fingerprint
        }) {
            return Err("Host key changed; saved trust was not replaced".into());
        }
        let entry = Entry {
            id: id.clone(),
            label,
            target: challenge.scan.target,
            fingerprint,
            phase: "trusted".into(),
            inspection: None,
            recommendation: None,
            endpoint: None,
            error: None,
            log: vec!["Owner confirmed SSH host fingerprint. No server changes made.".into()],
            plan: None,
            installation: None,
            connection_paused: false,
        };
        private_write(
            &self.directory.join(format!("{id}.known_hosts")),
            format!("{} {}\n", Self::alias(&id), challenge.key).as_bytes(),
        )?;
        inner.entries.insert(id, entry.clone());
        self.persist(&inner)?;
        Ok(entry)
    }
    fn inspect(&self, id: &str) -> Result<Entry, String> {
        let (entry, cancel) = self.begin(id)?;
        let result: Result<Entry, String> = (|| {
            self.record(
                id,
                "inspecting",
                "Read-only SSH inspection started; no installation or sudo changes.",
            )?;
            let mut args = self.ssh_args(&entry)?;
            args.extend(["--".into(), entry.target.host.clone(), "python3 -".into()]);
            let bytes = run(
                self.ssh_program(),
                &args,
                INSPECT.as_bytes(),
                Duration::from_secs(30),
                &cancel,
            )?;
            let inspection: Inspection = serde_json::from_slice(&bytes).map_err(|_| {
                "Server did not return a valid preflight response; Python 3 is required"
            })?;
            inspection.validate()?;
            let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            let current = inner.entries.get_mut(id).ok_or("Unknown setup target")?;
            if cancel.load(Ordering::SeqCst) {
                return Err("Inspection cancelled. No changes made.".into());
            }
            current.recommendation = Some(inspection.recommendation().into());
            current.inspection = Some(inspection);
            current.phase = "review".into();
            current.error = None;
            current.log.push("Inspection complete. Review the detected installation and blockers before continuing.".into());
            let result = current.clone();
            self.persist(&inner)?;
            Ok(result)
        })();
        if let Err(error) = &result {
            let _ = self.record(id, "failed", error);
        }
        self.inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .running
            .remove(id);
        result
    }
    async fn tunnel(&self, id: &str) -> Result<Entry, String> {
        let (entry, cancel) = self.begin(id)?;
        let result: Result<Entry, String> = async {
            if entry.connection_paused { return Err("SSH connection is paused".into()); }
            let inspection = entry.inspection.as_ref().ok_or("Inspect the host before connecting")?;
            let environment = inspection.environment.as_ref().ok_or("No environment-aware API was found. Installation or migration review is required.")?;
            self.record(id, "connecting", "Opening an owned loopback SSH route. Remote services are not started or stopped.")?;
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "Cannot reserve a local tunnel port")?;
            let port = listener.local_addr().map_err(|_| "Cannot read local tunnel port")?.port(); drop(listener);
            let mut args = self.ssh_args(&entry)?;
            args.extend(["-oExitOnForwardFailure=yes".into(), "-L".into(), format!("127.0.0.1:{port}:127.0.0.1:{}", inspection.api_port), "--".into(), entry.target.host.clone(), "printf 'outpost-forward-ready\\n'; exec cat >/dev/null".into()]);
            // Keeping stdin open owns the route. Desktop process exit closes the
            // pipe, remote cat exits, and SSH terminates without an orphan tunnel.
            if cancel.load(Ordering::SeqCst) { return Err("Connection cancelled.".into()); }
            let mut child = OwnedChild(Command::new(self.ssh_program()).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Cannot launch SSH")?);
            let output = child.stdout.take().ok_or("Missing SSH readiness channel")?;
            let (sender, receiver) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let mut line = Vec::new();
                let result = std::io::BufReader::new(output).take(65).read_until(b'\n', &mut line);
                let _ = sender.send(result.is_ok() && line == b"outpost-forward-ready\n");
            });
            let endpoint = format!("http://127.0.0.1:{port}");
            let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(2)).build().map_err(|_| "Cannot initialize route verification")?;
            let mut verified = false;
            let started = Instant::now(); let mut forwarding_ready = false;
            for _ in 0..100 {
                if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(20) || child.try_wait().map_err(|_| "Cannot inspect SSH process")?.is_some() { break; }
                if !forwarding_ready {
                    match receiver.try_recv() {
                        Ok(true) => forwarding_ready = true,
                        Ok(false) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                        Err(std::sync::mpsc::TryRecvError::Empty) => { tokio::time::sleep(Duration::from_millis(100)).await; continue; }
                    }
                }
                if let Ok(mut response) = client.get(format!("{endpoint}/v2/environment")).send().await {
                    if response.status().is_success() && response.content_length().unwrap_or(0) <= 32768 {
                        let header_matches = response.headers().get("x-outpost-environment-id").and_then(|value| value.to_str().ok()) == Some(environment.environment_id.as_str());
                        let mut bytes = Vec::new();
                        while let Ok(Some(chunk)) = response.chunk().await {
                            bytes.extend_from_slice(&chunk);
                            if bytes.len() > 32768 { break; }
                        }
                        if bytes.len() <= 32768 {
                                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                                    if !header_matches || value["environmentId"] != environment.environment_id || value["protocolVersion"] != 2 {
                                        let _ = child.kill(); let _ = child.wait(); return Err("Installation identity changed across the SSH route. Connection blocked.".into());
                                    }
                                    verified = true; break;
                                }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if !verified || cancel.load(Ordering::SeqCst) { let _ = child.kill(); let _ = child.wait(); return Err("SSH route did not verify. Check SSH agent/key access, API readiness and pinned host trust; nothing was installed.".into()); }
            let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            if cancel.load(Ordering::SeqCst) { let _ = child.kill(); let _ = child.wait(); return Err("Connection cancelled.".into()); }
            let current = inner.entries.get_mut(id).ok_or("Unknown setup target")?;
            current.endpoint = Some(endpoint); current.phase = "tunnel_ready".into(); current.error = None;
            current.log.push("SSH route verified against the inspected installation. Authenticate existing device enrollment before saving.".into());
            let result = current.clone(); inner.tunnels.insert(id.into(), child); self.persist(&inner)?; Ok(result)
        }.await;
        if let Err(error) = &result {
            let _ = self.disconnect(id);
            let _ = self.record(id, "failed", error);
        }
        self.inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .running
            .remove(id);
        result
    }
    fn disconnect(&self, id: &str) -> Result<Entry, String> {
        self.stop_route(id, false)
    }
    pub(crate) fn pause_route(&self, id: &str) -> Result<Entry, String> {
        self.stop_route(id, true)
    }
    pub(crate) fn resume_route(&self, id: &str) -> Result<(), String> {
        self.ready()?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        Self::restart_allowed(&inner, inner.entries.get(id).ok_or("Unknown setup target")?)?;
        let entry = inner.entries.get_mut(id).ok_or("Unknown setup target")?;
        entry.connection_paused = false;
        self.persist(&inner)
    }
    fn stop_route(&self, id: &str, pause: bool) -> Result<Entry, String> {
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        if let Some(activity) = inner.activities.get(id) {
            if activity.kind == history::ActivityKind::Restart {
                activity.cancel.store(true, Ordering::SeqCst);
            }
        }
        inner.restart_reviews.retain(|v| !v.belongs_to(id));
        if let Some(cancel) = inner.running.get(id) {
            cancel.store(true, Ordering::SeqCst);
        }
        if let Some(mut child) = inner.tunnels.remove(id) {
            let _ = child.kill();
            let _ = child.wait();
        }
        let Inner {
            entries,
            restart_journal,
            ..
        } = &mut *inner;
        let entry = entries.get_mut(id).ok_or("Unknown setup target")?;
        entry.endpoint = None;
        entry.connection_paused |= pause;
        if restart_journal.phase(entry).is_some() {
            restart_journal.project_entry(entry);
        } else {
            entry.phase = "disconnected".into();
            entry.error = None;
            entry
                .log
                .push("Owned route closed. No remote service was stopped or uninstalled.".into());
            if entry.log.len() > 100 {
                entry.log.remove(0);
            }
        }
        let result = entry.clone();
        self.persist(&inner)?;
        Ok(result)
    }
    pub fn wake(&self) {
        self.wake_generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut inner) = self.inner.lock() {
            for cancel in inner.running.values() {
                cancel.store(true, Ordering::SeqCst);
            }
            for activity in inner.activities.values() {
                activity.cancel.store(true, Ordering::SeqCst);
            }
            inner.diagnostic_cache.clear();
            inner.restart_reviews.clear();
            for (_, mut child) in std::mem::take(&mut inner.tunnels) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    fn list(&self) -> Result<Vec<Entry>, String> {
        self.ready()?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let exited: Vec<_> = inner
            .tunnels
            .iter_mut()
            .filter_map(|(id, child)| child.try_wait().ok().flatten().map(|_| id.clone()))
            .collect();
        let mut changed = !exited.is_empty();
        for id in exited {
            inner.tunnels.remove(&id);
            if let Some(entry) = inner.entries.get_mut(&id) {
                entry.endpoint = None;
                entry.phase = "disconnected".into();
                entry.error = Some("SSH route closed. Saved trusted connections recover automatically; remote services continue independently.".into());
            }
        }
        let Inner {
            entries,
            restart_journal,
            ..
        } = &mut *inner;
        for entry in entries.values_mut() {
            changed |= restart_journal.project_entry(entry);
        }
        if changed {
            self.persist(&inner)?;
        }
        Ok(inner.entries.values().cloned().collect())
    }
}
fn setup_log_text(entry: &Entry) -> Result<String, String> {
    // Select fields rather than exporting Entry/Target/InstallPlan wholesale. In
    // particular, identity paths, enrollment keys and unrelated entries stay private.
    let plan = serde_json::to_value(&entry.plan).map_err(|_| "Cannot format setup plan")?;
    let installation = serde_json::to_value(&entry.installation)
        .map_err(|_| "Cannot format installation receipt")?;
    let sections = [
        (
            "Setup",
            json!({
                "id": entry.id, "label": entry.label,
                "target": { "host": entry.target.host, "user": entry.target.user, "port": entry.target.port },
                "fingerprint": entry.fingerprint, "phase": entry.phase,
                "recommendation": entry.recommendation, "connectionPaused": entry.connection_paused,
                "error": entry.error, "log": entry.log,
            }),
        ),
        (
            "Inspection",
            serde_json::to_value(&entry.inspection).map_err(|_| "Cannot format inspection")?,
        ),
        (
            "Reviewed installation plan",
            if plan.is_null() {
                Value::Null
            } else {
                json!({
                    "operationId": plan["operationId"], "environmentId": plan["environmentId"], "releaseId": plan["releaseId"],
                })
            },
        ),
        (
            "Installation receipt",
            if installation.is_null() {
                Value::Null
            } else {
                json!({
                    "operationId": installation["operationId"], "environmentId": installation["environmentId"], "releaseId": installation["releaseId"],
                    "state": installation["state"], "completedSteps": installation["completedSteps"], "totalSteps": installation["totalSteps"],
                    "stage": installation["stage"], "startedAt": installation["startedAt"], "updatedAt": installation["updatedAt"],
                    "error": installation["error"], "log": installation["log"],
                })
            },
        ),
    ];
    let mut report = format!("Outpost setup diagnostic log\nExported at (Unix milliseconds): {}\nOnly the selected journal entry is included; credentials and key files are not read.\n", now());
    for (title, value) in sections {
        report.push_str(&format!("\n{title}\n{}\n", "-".repeat(title.len())));
        if value.is_null() {
            report.push_str("Not recorded\n");
        } else {
            report.push_str(
                &serde_json::to_string_pretty(&value).map_err(|_| "Cannot format setup log")?,
            );
            report.push('\n');
        }
    }
    Ok(report)
}

fn setup_log_directory(downloads: &std::path::Path) -> Result<PathBuf, String> {
    if !downloads.is_absolute() || !downloads.is_dir() {
        return Err("Downloads directory is unavailable".into());
    }
    let mut directory = downloads.to_path_buf();
    for component in ["Outpost", "setup-logs"] {
        directory.push(component);
        durable_directory(&directory)
            .map_err(|e| format!("Cannot create setup log directory: {e}"))?;
        let metadata = fs::symlink_metadata(&directory)
            .map_err(|e| format!("Cannot inspect setup log directory: {e}"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Setup log directory must be a real directory, not a symbolic link".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Cannot protect setup log directory: {e}"))?;
    }
    Ok(directory)
}

fn private_setup_log_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("Missing setup log directory")?;
    let temp = directory.join(format!(".outpost-setup-{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| format!("Cannot create private setup log: {e}"))?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        // Match private_write's private, synced staging, but publish without rename's
        // overwrite behavior. A preexisting file or symlink makes hard_link fail.
        fs::hard_link(&temp, path)
    })();
    drop(file);
    let cleanup = fs::remove_file(&temp);
    result
        .map_err(|e| format!("Cannot save setup log without overwriting an existing file: {e}"))?;
    cleanup.map_err(|e| format!("Cannot remove temporary setup log: {e}"))?;
    sync_directory(directory).map_err(|e| format!("Cannot sync setup log directory: {e}"))
}

fn parse_key(output: &str) -> Result<(String, String), String> {
    let lines: Vec<_> = output
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .collect();
    if lines.len() != 1 {
        return Err("Expected one Ed25519 SSH host key. No trust was saved.".into());
    }
    let fields: Vec<_> = lines[0].split_whitespace().collect();
    if fields.len() != 3 || fields[1] != "ssh-ed25519" {
        return Err("Unsupported SSH host key".into());
    }
    let bytes = STANDARD
        .decode(fields[2])
        .map_err(|_| "Invalid SSH host key encoding")?;
    if bytes.len() != 51 || &bytes[..19] != b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" {
        return Err("Invalid Ed25519 host key".into());
    }
    let fingerprint = format!(
        "SHA256:{}",
        STANDARD
            .encode(Sha256::digest(&bytes))
            .trim_end_matches('=')
    );
    Ok((format!("ssh-ed25519 {}", fields[2]), fingerprint))
}
fn run(
    program: &str,
    args: &[String],
    input: &[u8],
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    run_bounded(program, args, input, timeout, cancelled, 65536)
}
fn run_bounded(
    program: &str,
    args: &[String],
    input: &[u8],
    timeout: Duration,
    cancelled: &AtomicBool,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("SSH operation cancelled before starting.".into());
    }
    let mut child = OwnedChild(
        Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Cannot launch the required local SSH tool")?,
    );
    let mut stdin = child.stdin.take().ok_or("Missing process input")?;
    let mut stdout = child.stdout.take().ok_or("Missing process output")?;
    let mut input = zeroize::Zeroizing::new(input.to_vec());
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&input);
        input.fill(0);
    });
    let overflow = Arc::new(AtomicBool::new(false));
    let reader_overflow = overflow.clone();
    let reader = thread::spawn(move || {
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        let result = stdout
            .by_ref()
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes);
        reader_overflow.store(bytes.len() > limit, Ordering::SeqCst);
        (result, bytes)
    });
    let start = Instant::now();
    let status = loop {
        if cancelled.load(Ordering::SeqCst)
            || start.elapsed() >= timeout
            || overflow.load(Ordering::SeqCst)
        {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let _ = writer.join();
    let (result, mut bytes) = reader.join().map_err(|_| "SSH output interrupted")?;
    if status.is_none() {
        return Err("SSH operation cancelled or timed out.".into());
    }
    if !status.is_some_and(|status| status.success()) {
        return Err("SSH operation failed. Check the host, pinned key and unlocked SSH identity/agent; interactive password login is not enabled.".into());
    }
    if result.is_err() || bytes.len() > limit {
        return Err("SSH response exceeded the bounded inspection protocol".into());
    }
    Ok(std::mem::take(&mut *bytes))
}
#[tauri::command]
pub async fn setup_choose_identity() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let bytes = run("/usr/bin/osascript", &["-e".into(), "POSIX path of (choose file with prompt \"Select an SSH private key; it stays on this Mac\")".into()], b"", Duration::from_secs(300), &AtomicBool::new(false)).map_err(|_| "SSH key selection cancelled or unavailable")?;
        let path = String::from_utf8(bytes).map_err(|_| "Invalid selected path")?.trim().to_string();
        let target = Target { host: "localhost".into(), user: "unused".into(), port: 22, identity_file: Some(path.clone()) };
        target.validate()?; target.check_key()?; Ok(path)
    }).await.map_err(|_| "Key selection interrupted")?
}
#[tauri::command]
pub fn setup_list(setup: tauri::State<'_, Arc<Setup>>) -> Result<Vec<Entry>, String> {
    setup.list()
}
#[tauri::command]
pub async fn setup_export_log(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<String, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| format!("Downloads directory unavailable: {e}"))?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || setup.export_log(&id, &downloads))
        .await
        .map_err(|_| "Setup log export interrupted")?
}
#[tauri::command]
pub async fn setup_scan(
    setup: tauri::State<'_, Arc<Setup>>,
    target: Target,
) -> Result<Scan, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || setup.scan(target))
        .await
        .map_err(|_| "SSH scan interrupted")?
}
#[tauri::command]
pub fn setup_trust(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
    fingerprint: String,
    label: String,
) -> Result<Entry, String> {
    setup.trust(id, fingerprint, label)
}
#[tauri::command]
pub async fn setup_inspect(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<Entry, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || setup.inspect(&id))
        .await
        .map_err(|_| "SSH inspection interrupted")?
}
#[tauri::command]
pub async fn setup_tunnel(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    id: String,
) -> Result<Entry, String> {
    for (environment, binding) in registry.ssh_bindings()? {
        if binding.setup_id == id {
            registry.ssh_policy(&environment, false)?;
        }
    }
    setup.resume_route(&id)?;
    setup.tunnel(&id).await
}
#[tauri::command]
pub fn connections_wake(setup: tauri::State<'_, Arc<Setup>>) {
    setup.wake();
}
#[tauri::command]
pub fn setup_disconnect(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    id: String,
) -> Result<Entry, String> {
    for (environment, binding) in registry.ssh_bindings()? {
        if binding.setup_id == id {
            registry.ssh_policy(&environment, true)?;
        }
    }
    setup.pause_route(&id)
}

#[cfg(test)]
#[path = "server_diagnostic_test_support.rs"]
mod diagnostic_test_support;

#[cfg(test)]
#[path = "server_setup_tests.rs"]
pub(crate) mod tests;
