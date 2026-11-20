//! Bound desktop connections. Legacy State/IPC remains separate until its pending work is settled.
use super::*;
use std::{collections::BTreeMap, sync::Arc};
#[path = "managed_routes.rs"]
mod managed_routes;
use managed_routes::is_loopback;
#[path = "environment_restart.rs"]
mod restart;
use restart::RestartFences;

pub fn validate_id(id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(id).map_err(|_| "Invalid installation/record UUID")?;
    if parsed.to_string() != id {
        return Err("UUID must use canonical lowercase spelling".into());
    }
    Ok(())
}
fn label(value: &str) -> Result<(), String> {
    if value.trim() != value
        || value.is_empty()
        || value.chars().count() > 80
        || value.chars().any(char::is_control)
    {
        return Err("Label must contain 1–80 printable characters".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedEnvironment {
    environment_id: String,
    label: String,
    routes: Vec<String>,
    active_route: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh: Option<SshBinding>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshBinding {
    pub setup_id: String,
    pub route: String,
    pub paused: bool,
    pub generation: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    version: u8,
    legacy_mutations_retired: bool,
    selected_environment_id: Option<String>,
    environments: BTreeMap<String, SavedEnvironment>,
}
impl Metadata {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported environment registry version".into());
        }
        for (id, entry) in &self.environments {
            validate_id(id)?;
            label(&entry.label)?;
            if id != &entry.environment_id
                || entry.routes.is_empty()
                || !entry.routes.contains(&entry.active_route)
            {
                return Err("Invalid saved environment binding/routes".into());
            }
            if let Some(ssh) = &entry.ssh {
                validate_id(&ssh.setup_id)?;
                if ssh.route != entry.active_route || !is_loopback(&ssh.route) {
                    return Err("Invalid managed SSH route".into());
                }
            }
            let mut seen = std::collections::BTreeSet::new();
            for route in &entry.routes {
                if validate_endpoint(route)? != *route || !seen.insert(route) {
                    return Err("Invalid/duplicate saved route".into());
                }
            }
        }
        if self
            .selected_environment_id
            .as_ref()
            .is_some_and(|id| !self.environments.contains_key(id))
        {
            return Err("Selected environment is not registered".into());
        }
        Ok(())
    }
}
fn ensure_no_legacy_pending(directory: &std::path::Path) -> Result<(), String> {
    match fs::metadata(directory.join("pending.enc")) {
        Ok(_) => Err("Unbound legacy pending command: resolve with legacy retry_command on its original endpoint before adopting any unknown enrolled environment. Explicit bootstrap of a different new installation remains available.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot inspect legacy pending storage: {e}")),
    }
}
pub(super) fn has_saved_environments(directory: &std::path::Path) -> Result<bool, String> {
    match fs::read(directory.join("environments/registry.json")) {
        Ok(bytes) => {
            let metadata: Metadata =
                serde_json::from_slice(&bytes).map_err(|_| "Corrupt registry")?;
            metadata.validate()?;
            Ok(!metadata.environments.is_empty())
        }
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound
                && !directory.join("environments").exists() =>
        {
            Ok(false)
        }
        Err(e) => Err(e.to_string()),
    }
}
pub(super) fn allow_legacy_mutation(directory: &std::path::Path) -> Result<(), String> {
    let root = directory.join("environments");
    match fs::metadata(&root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
        Ok(_) => {}
    }
    let metadata: Metadata =
        serde_json::from_slice(&fs::read(root.join("registry.json")).map_err(|e| e.to_string())?)
            .map_err(|_| "Corrupt registry; legacy mutations blocked")?;
    metadata.validate()?;
    if metadata.legacy_mutations_retired {
        return Err("Legacy connection is read-only after adoption. Use environment-bound IPC for commands, enrollment and provider operations.".into());
    }
    Ok(())
}
struct RegistryInner {
    metadata: Metadata,
    connections: BTreeMap<String, Arc<State>>,
    registration: BTreeMap<String, Arc<tokio::sync::Mutex<()>>>,
    lifecycle: BTreeMap<String, Value>,
    restart_fences: RestartFences,
}
#[cfg(test)]
pub(super) struct ExistingIdentityStore<S>(pub(super) S);
#[cfg(test)]
impl<S: IdentityStore> IdentityStore for ExistingIdentityStore<S> {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        self.0
            .read()?
            .map(Some)
            .ok_or_else(|| "Existing Keychain identity required; no identity was created.".into())
    }
    fn write(&self, _bytes: &[u8]) -> Result<(), String> {
        Err("Identity creation/replacement is forbidden in this test executable.".into())
    }
}
#[cfg(test)]
pub(super) fn existing_keychain_identity() -> Arc<dyn IdentityStore> {
    Arc::new(ExistingIdentityStore(KeychainIdentityStore))
}

pub struct Registry {
    directory: PathBuf,
    legacy_mutation: Arc<tokio::sync::Mutex<()>>,
    inner: Mutex<RegistryInner>,
    #[cfg(test)]
    pub(crate) fixture_identity: bool,
}
impl Registry {
    pub fn new(
        directory: PathBuf,
        legacy_mutation: Arc<tokio::sync::Mutex<()>>,
    ) -> Result<Self, String> {
        // Directory existence is the initialization marker: missing metadata after initialization fails closed.
        let root = directory.join("environments");
        let fresh = durable_directory(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let path = root.join("registry.json");
        let metadata = if fresh {
            let metadata = Metadata {
                version: 1,
                legacy_mutations_retired: false,
                selected_environment_id: None,
                environments: BTreeMap::new(),
            };
            private_write(&path, &serde_json::to_vec(&metadata).unwrap())?;
            metadata
        } else {
            serde_json::from_slice::<Metadata>(
                &fs::read(&path).map_err(|e| format!("Cannot read initialized registry: {e}"))?,
            )
            .map_err(|e| format!("Corrupt environment registry: {e}"))?
        };
        metadata.validate()?;
        let restart_fences = RestartFences::load(&root)?;
        let mut connections = BTreeMap::new();
        for (id, entry) in &metadata.environments {
            let state = Self::connection(&root, id, &entry.active_route)?;
            if restart_fences.contains(id) {
                state
                    .removed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            if entry.ssh.is_some() || restart_fences.contains(id) {
                state
                    .route_available
                    .store(false, std::sync::atomic::Ordering::SeqCst);
            }
            connections.insert(id.clone(), Arc::new(state));
        }
        Ok(Self {
            directory,
            legacy_mutation,
            inner: Mutex::new(RegistryInner {
                metadata,
                connections,
                registration: BTreeMap::new(),
                lifecycle: BTreeMap::new(),
                restart_fences,
            }),
            #[cfg(test)]
            fixture_identity: false,
        })
    }
    fn connection(root: &std::path::Path, id: &str, endpoint: &str) -> Result<State, String> {
        validate_id(id)?;
        let directory = root.join(id);
        durable_directory(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let mut state = State::new(directory).map_err(|e| e.to_string())?;
        // Test executables (including guarded live operators) may read an existing
        // real identity, but must never create a Keychain identity as a fallback.
        #[cfg(test)]
        {
            state.identity_store = Some(existing_keychain_identity());
        }
        state.environment_id = Some(id.into());
        state
            .client
            .get_mut()
            .map_err(|_| "Connection lock failed")?
            .endpoint = validate_endpoint(endpoint)?;
        Ok(state)
    }
    pub(super) fn get(&self, id: &str) -> Result<Arc<State>, String> {
        validate_id(id)?;
        self.restart_unfenced(id)?;
        self.inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .connections
            .get(id)
            .cloned()
            .ok_or("Environment is not registered".into())
    }
    fn update(
        &self,
        change: impl FnOnce(&mut Metadata) -> Result<(), String>,
    ) -> Result<Metadata, String> {
        let mut inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        let mut metadata = inner.metadata.clone();
        change(&mut metadata)?;
        metadata.validate()?;
        private_write(
            &self.directory.join("environments/registry.json"),
            &serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
        )?;
        inner.metadata = metadata.clone();
        Ok(metadata)
    }
    async fn register(
        &self,
        id: String,
        endpoint: String,
        name: String,
        token: Option<String>,
        retire_legacy_mutations: bool,
    ) -> Result<Metadata, String> {
        self.register_inner(id, endpoint, name, token, retire_legacy_mutations, false)
            .await
    }
    // Only the native installer calls this after checking its pinned-host creation receipt.
    pub(crate) async fn register_created(
        &self,
        id: String,
        endpoint: String,
        name: String,
    ) -> Result<Metadata, String> {
        self.register_inner(id, endpoint, name, None, false, true)
            .await
    }
    async fn register_inner(
        &self,
        id: String,
        endpoint: String,
        name: String,
        token: Option<String>,
        retire_legacy_mutations: bool,
        created_here: bool,
    ) -> Result<Metadata, String> {
        validate_id(&id)?;
        label(&name)?;
        let endpoint = validate_endpoint(&endpoint)?;
        let legacy_endpoint = legacy_endpoint(&self.directory)?;
        let already_saved = self.get(&id).is_ok();
        let retired = self
            .inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .metadata
            .legacy_mutations_retired;
        let retire_legacy = !retired
            && !legacy_endpoint.is_empty()
            && (endpoint == legacy_endpoint
                || (token.is_none() && !already_saved && !created_here));
        // An unknown adopted route may alias the legacy installation. Do not guess its ownership.
        let _legacy_gate = if retire_legacy {
            Some(
                self.legacy_mutation
                    .try_lock()
                    .map_err(|_| "Legacy operation in progress; finish it before adopting")?,
            )
        } else {
            None
        };
        if token.is_none() && !already_saved && !created_here || retire_legacy {
            ensure_no_legacy_pending(&self.directory)?;
        }
        if retire_legacy && endpoint != legacy_endpoint && !retire_legacy_mutations {
            return Err("needs_legacy_retirement: adopting an unknown enrolled environment may alias the legacy server. Confirm retireLegacyMutations to make the old connection read-only (including provider operations), or keep using legacy IPC.".into());
        }
        let gate = self
            .inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .registration
            .entry(id.clone())
            .or_default()
            .clone();
        let _registration = gate.lock().await;
        self.restart_unfenced(&id)?;
        let candidate = Self::connection(&self.directory.join("environments"), &id, &endpoint)?;
        #[cfg(test)]
        if self.fixture_identity {
            tests::identify(&candidate);
        }
        let descriptor = discover(&endpoint).await?;
        validate_descriptor(&descriptor, Some(&id))?;
        let bootstrapped = token.is_some();
        if let Some(token) = token {
            if self.get(&id).is_ok() {
                return Err(
                    "Environment already saved; adopt a verified route without pairing".into(),
                );
            }
            let attempt = candidate.directory.join("pairing-attempt");
            match fs::metadata(&attempt) {
                Ok(_) => return Err("Pairing may already have succeeded. Adopt using the existing device identity; do not reenroll automatically.".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                Err(e) => return Err(e.to_string()),
            }
            private_write(
                &attempt,
                b"Pairing attempted; authenticate existing identity before any further enrollment.",
            )?;
            candidate.pair(token).await.map_err(|_| "Pairing not confirmed. It may have succeeded; try adoption with the existing identity, not automatic reenrollment.")?;
        }
        let confirmed = query_value(&candidate, "environment".into(), json!({})).await
            .map_err(|e| format!("Environment not saved: authenticated confirmation failed. If pairing was attempted, adopt with the same device identity. {e}"))?;
        validate_descriptor(&confirmed, Some(&id))?;
        // Updating a route never rebinds pending work. Serialize with mutations of this installation only.
        let existing = self.get(&id).ok();
        let _mutation = match &existing {
            Some(state) => Some(state.mutation.lock().await),
            None => None,
        };
        // Independent bootstrap does not hold the legacy gate over network I/O. Recheck at commit.
        let partial = |error: String| {
            if bootstrapped {
                format!("Paired, registration not completed; verify/adopt the enrolled device, do not bootstrap again. {error}")
            } else {
                error
            }
        };
        let _commit_gate = if (bootstrapped || created_here) && _legacy_gate.is_none() {
            Some(
                self.legacy_mutation
                    .try_lock()
                    .map_err(|_| partial("Legacy operation in progress".into()))?,
            )
        } else {
            None
        };
        let current_legacy_endpoint = super::legacy_endpoint(&self.directory).map_err(&partial)?;
        if created_here && endpoint == current_legacy_endpoint {
            return Err("New installation route conflicts with the legacy route".into());
        }
        let retire_legacy = retire_legacy || (bootstrapped && endpoint == current_legacy_endpoint);
        if retire_legacy {
            ensure_no_legacy_pending(&self.directory).map_err(&partial)?;
        }
        let metadata = self
            .update(|metadata| {
                if retire_legacy {
                    metadata.legacy_mutations_retired = true;
                }
                let entry = metadata
                    .environments
                    .entry(id.clone())
                    .or_insert(SavedEnvironment {
                        environment_id: id.clone(),
                        label: name.clone(),
                        routes: Vec::new(),
                        active_route: endpoint.clone(),
                        ssh: None,
                    });
                entry.label = name;
                if !entry.routes.contains(&endpoint) {
                    entry.routes.push(endpoint.clone());
                }
                entry.active_route = endpoint.clone();
                if entry.ssh.as_ref().is_some_and(|ssh| ssh.route != endpoint) {
                    entry.ssh = None;
                }
                Ok(())
            })
            .map_err(partial)?;
        if let Some(state) = &existing {
            state.activate_route(endpoint)?;
        } else {
            self.inner
                .lock()
                .map_err(|_| "Registry lock failed")?
                .connections
                .insert(id, Arc::new(candidate));
        }
        Ok(metadata)
    }
}

// Discovery is untrusted metadata. Only the signed confirmation permits registration.
fn validate_descriptor(value: &Value, expected: Option<&str>) -> Result<(), String> {
    let id = value["environmentId"]
        .as_str()
        .ok_or("Missing installation UUID")?;
    validate_id(id)?;
    if expected.is_some_and(|expected| expected != id) {
        return Err("Discovered installation does not match expected environment".into());
    }
    fn keys(value: &Value, expected: &[&str]) -> Result<(), String> {
        let object = value.as_object().ok_or("Invalid descriptor object")?;
        if object.len() != expected.len() || expected.iter().any(|k| !object.contains_key(*k)) {
            return Err("Unexpected descriptor fields".into());
        }
        Ok(())
    }
    keys(
        value,
        &[
            "descriptorVersion",
            "environmentId",
            "label",
            "protocolVersion",
            "recordProtocolVersion",
            "supportedProtocolVersions",
            "legacyUnboundRequests",
            "runtime",
            "capabilities",
            "services",
        ],
    )?;
    if value["descriptorVersion"] != 1
        || value["protocolVersion"] != 2
        || value["recordProtocolVersion"] != 1
        || (value["supportedProtocolVersions"] != json!([2])
            && value["supportedProtocolVersions"] != json!([1, 2]))
        || value["legacyUnboundRequests"]
            != json!(value["supportedProtocolVersions"] == json!([1, 2]))
    {
        return Err("Server does not support the required bound protocol 2".into());
    }
    label(value["label"].as_str().ok_or("Missing environment label")?)?;
    let capabilities = &value["capabilities"];
    keys(
        capabilities,
        &[
            "environmentBoundRequests",
            "snapshots",
            "eventStream",
            "artifacts",
            "deviceEnrollment",
            "historyReplication",
            "taskHandoff",
        ],
    )?;
    for key in [
        "environmentBoundRequests",
        "snapshots",
        "eventStream",
        "artifacts",
        "deviceEnrollment",
    ] {
        if capabilities[key] != true {
            return Err("Invalid descriptor capability".into());
        }
    }
    for key in ["historyReplication", "taskHandoff"] {
        if capabilities[key] != false {
            return Err("Unsupported descriptor capability".into());
        }
    }
    keys(&value["runtime"], &["release", "platform", "architecture"])?;
    for key in ["platform", "architecture"] {
        let text = value["runtime"][key]
            .as_str()
            .ok_or("Invalid runtime descriptor")?;
        if text.is_empty() || text.chars().count() > 32 {
            return Err("Invalid runtime descriptor".into());
        }
    }
    if !value["runtime"]["release"].is_null() {
        let release = value["runtime"]["release"]
            .as_str()
            .ok_or("Invalid runtime release")?;
        if release.is_empty()
            || release.len() > 128
            || !release
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err("Invalid runtime release".into());
        }
    }
    keys(&value["services"], &["worker", "hostAdministration"])?;
    for service in ["worker", "hostAdministration"] {
        let status = &value["services"][service];
        keys(status, &["configured", "readiness"])?;
        if !((status["configured"] == true && status["readiness"] == "unknown")
            || (status["configured"] == false && status["readiness"] == "not_configured"))
        {
            return Err("Invalid service readiness".into());
        }
    }
    Ok(())
}
async fn discover(endpoint: &str) -> Result<Value, String> {
    let endpoint = validate_endpoint(endpoint)?;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("{endpoint}/v2/environment"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("Environment discovery failed; no legacy fallback".into());
    }
    let header_id = response
        .headers()
        .get("x-outpost-environment-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let version = response
        .headers()
        .get("x-outpost-protocol-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let descriptor: Value = response
        .json()
        .await
        .map_err(|_| "Invalid discovery response")?;
    validate_descriptor(&descriptor, Some(&header_id))?;
    if version != "2" {
        return Err("Discovery protocol mismatch".into());
    }
    Ok(descriptor)
}
pub(super) async fn query_value(
    state: &State,
    kind: String,
    payload: Value,
) -> Result<Value, String> {
    query_command_value(state, kind, payload)
        .await
        .map_err(QueryError::into_message)
}

async fn query_command_value(
    state: &State,
    kind: String,
    payload: Value,
) -> Result<Value, QueryError> {
    let response = state
        .request("v1/query", json!({"type": kind, "payload": payload}), true)
        .await?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid query response")?;
    if !status.is_success() {
        return Err(query_rejection(&kind, &value, "Query rejected"));
    }
    Ok(value)
}
impl State {
    pub(super) fn cancel_stream(&self) -> Result<(), String> {
        if let Some(cancel) = self.stream.lock().map_err(|_| "Stream lock failed")?.take() {
            let _ = cancel.send(true);
        }
        Ok(())
    }
    fn activate_route(&self, endpoint: String) -> Result<(), String> {
        let mut stream = self.stream.lock().map_err(|_| "Stream lock failed")?;
        if let Some(cancel) = stream.take() {
            let _ = cancel.send(true);
        }
        self.client
            .lock()
            .map_err(|_| "Connection lock failed")?
            .endpoint = endpoint;
        self.route_available
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    fn prepare_stream(
        &self,
    ) -> Result<(tokio::sync::watch::Receiver<bool>, reqwest::RequestBuilder), String> {
        let mut stream = self.stream.lock().map_err(|_| "Stream lock failed")?;
        let request =
            self.prepare_request("v1/stream", json!({"type":"subscribe", "payload":{}}), true)?;
        let (sender, cancelled) = tokio::sync::watch::channel(false);
        if let Some(previous) = stream.replace(sender) {
            let _ = previous.send(true);
        }
        Ok((cancelled, request))
    }
    // Both legacy and registered clients use this lifecycle; prepare_request selects v1/v2.
    pub(super) async fn bound_stream(
        &self,
        channel: tauri::ipc::Channel<Value>,
    ) -> Result<(), String> {
        let (cancelled, request) = self.prepare_stream()?;
        let consume = async {
            let mut response = self.send_request(request).await?;
            if !response.status().is_success() {
                return Err("Live stream rejected".into());
            }
            let mut decoder = crate::sse::Decoder::default();
            while let Some(bytes) = response.chunk().await.map_err(|e| e.to_string())? {
                for frame in decoder.push(&bytes)? {
                    // Cancellation and delivery share the route lifecycle lock.
                    let _stream = self.stream.lock().map_err(|_| "Stream lock failed")?;
                    if *cancelled.borrow() {
                        return Ok(());
                    }
                    channel.send(frame).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        };
        let mut stop = cancelled.clone();
        if *stop.borrow() {
            return Ok(());
        }
        tokio::select! { biased; _ = stop.changed() => Ok(()), result = consume => result }
    }
}

#[tauri::command]
pub fn environment_list(registry: tauri::State<'_, Registry>) -> Result<Value, String> {
    let metadata = registry
        .inner
        .lock()
        .map_err(|_| "Registry lock failed")?
        .metadata
        .clone();
    let legacy_endpoint = match fs::read_to_string(registry.directory.join("endpoint")) {
        Ok(value) if value.is_empty() => None,
        Ok(value) => Some(validate_endpoint(value.trim())?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let legacy_pending = match fs::metadata(registry.directory.join("pending.enc")) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.to_string()),
    };
    Ok(
        json!({"registry":metadata, "legacy": {"endpoint":legacy_endpoint, "pending":legacy_pending}}),
    )
}
#[tauri::command]
pub async fn environment_discover(endpoint: String) -> Result<Value, String> {
    discover(&endpoint).await
}
#[tauri::command]
pub async fn environment_register(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    endpoint: String,
    label: String,
    bootstrap_token: Option<String>,
    retire_legacy_mutations: Option<bool>,
) -> Result<Metadata, String> {
    registry
        .register(
            environment_id,
            endpoint,
            label,
            bootstrap_token,
            retire_legacy_mutations.unwrap_or(false),
        )
        .await
}
#[tauri::command]
pub fn environment_select(
    registry: tauri::State<'_, Registry>,
    environment_id: Option<String>,
) -> Result<Metadata, String> {
    registry.update(|metadata| {
        metadata.selected_environment_id = environment_id;
        Ok(())
    })
}
#[tauri::command]
pub fn environment_rename(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    label: String,
) -> Result<Metadata, String> {
    registry.update(|metadata| {
        metadata
            .environments
            .get_mut(&environment_id)
            .ok_or("Environment is not registered")?
            .label = label;
        Ok(())
    })
}
#[tauri::command]
pub fn environment_disconnect(
    registry: tauri::State<'_, Registry>,
    setup: tauri::State<'_, Arc<server_setup::Setup>>,
    environment_id: String,
    pause: Option<bool>,
) -> Result<(), String> {
    if pause == Some(true) {
        if let Some(binding) = registry.ssh_policy(&environment_id, true)? {
            setup.pause_route(&binding.setup_id)?;
        }
    }
    registry.get(&environment_id)?.cancel_stream()
}
#[tauri::command]
pub fn environment_connection_policy(
    registry: tauri::State<'_, Registry>,
    setup: tauri::State<'_, Arc<server_setup::Setup>>,
    environment_id: String,
    enabled: bool,
) -> Result<(), String> {
    if let Some(binding) = registry.ssh_policy(&environment_id, !enabled)? {
        if enabled {
            setup.resume_route(&binding.setup_id)?;
        } else {
            setup.pause_route(&binding.setup_id)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn environment_connection_info(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
) -> Result<Value, String> {
    let lifecycle = registry.lifecycle(&environment_id)?;
    let state = registry.get(&environment_id)?;
    let mut client = state.client.lock().map_err(|_| "Connection lock failed")?;
    state.identity(&mut client)?;
    let pending_error = state.load_pending(&mut client).err();
    let identity = client.identity.as_ref().unwrap();
    Ok(
        json!({"environmentId":environment_id, "endpoint":client.endpoint, "deviceId":identity.id,
        "publicKey":STANDARD.encode(identity.key.verifying_key().to_bytes()), "pending":client.pending.is_some(), "pendingError":pending_error, "nativeSidebar":false, "lifecycle":lifecycle}),
    )
}
#[tauri::command]
pub async fn environment_query(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    kind: String,
    payload: Value,
) -> Result<Value, QueryError> {
    query_command_value(registry.get(&environment_id)?.as_ref(), kind, payload).await
}
#[tauri::command]
pub async fn environment_browser_request(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    payload: Value,
) -> Result<Value, String> {
    registry
        .get(&environment_id)?
        .browser_request(payload)
        .await
}

#[tauri::command]
pub async fn environment_agent_request(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    payload: Value,
) -> Result<Value, String> {
    super::public_management_request(&payload)?;
    registry.get(&environment_id)?.agent_request(payload).await
}
#[tauri::command]
pub async fn environment_send_command(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    kind: String,
    id: String,
    revision: u64,
    payload: Value,
) -> Result<Value, String> {
    registry
        .get(&environment_id)?
        .send_command(kind, id, revision, payload)
        .await
}
#[tauri::command]
pub async fn environment_retry_command(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
) -> Result<Value, String> {
    registry.get(&environment_id)?.retry_command().await
}
#[tauri::command]
pub async fn environment_enroll_device(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    device_id: String,
    name: String,
    public_key: String,
) -> Result<Value, String> {
    registry
        .get(&environment_id)?
        .enroll_device(device_id, name, public_key)
        .await
}
#[tauri::command]
pub async fn environment_stream_events(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    channel: tauri::ipc::Channel<Value>,
) -> Result<(), String> {
    registry.get(&environment_id)?.bound_stream(channel).await
}
#[tauri::command]
pub async fn environment_artifact(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    id: String,
    hash: String,
) -> Result<String, String> {
    validate_id(&id)?;
    Ok(STANDARD.encode(artifact_bytes(registry.get(&environment_id)?.as_ref(), &id, &hash).await?))
}
fn artifact_directory(
    downloads: &std::path::Path,
    environment_id: &str,
    id: &str,
) -> Result<PathBuf, String> {
    validate_id(environment_id)?;
    validate_id(id)?;
    Ok(downloads.join("Outpost").join(environment_id).join(id))
}
#[tauri::command]
pub async fn environment_save_artifact(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    id: String,
    hash: String,
    name: String,
) -> Result<String, String> {
    let state = registry.get(&environment_id)?;
    validate_id(&id)?;
    if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
        return Err("Invalid filename".into());
    }
    let directory = artifact_directory(
        &app.path().download_dir().map_err(|e| e.to_string())?,
        &environment_id,
        &id,
    )?;
    let bytes = artifact_bytes(&state, &id, &hash).await?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(name);
    private_write(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn environment_save_workspace_file(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Registry>,
    environment_id: String,
    task_id: String,
    path: String,
    hash: String,
) -> Result<String, String> {
    let owner = registry.get(&environment_id)?;
    let snapshot = workspace_file(&owner, &task_id, &path, &hash).await?;
    save_workspace_snapshot(
        &app.path().download_dir().map_err(|e| e.to_string())?,
        snapshot,
    )
}

#[tauri::command]
pub async fn environment_remove(
    registry: tauri::State<'_, Registry>,
    environment_id: String,
) -> Result<Metadata, String> {
    registry.remove(environment_id).await
}
impl Registry {
    async fn remove(&self, environment_id: String) -> Result<Metadata, String> {
        let gate = self
            .inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .registration
            .entry(environment_id.clone())
            .or_default()
            .clone();
        let _registration = gate.lock().await;
        let state = self.get(&environment_id)?;
        let _mutation = state.mutation.lock().await;
        {
            let mut client = state.client.lock().map_err(|_| "Connection lock failed")?;
            state.load_pending(&mut client)?;
            if client.pending.is_some() {
                return Err("Resolve pending work before removing this environment".into());
            }
        }
        let metadata = self.update(|metadata| {
            metadata.environments.remove(&environment_id);
            if metadata.selected_environment_id.as_ref() == Some(&environment_id) {
                metadata.selected_environment_id = None;
            }
            Ok(())
        })?;
        state
            .removed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        state.cancel_stream()?;
        self.inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .connections
            .remove(&environment_id);
        // Preserve private recovery directories; removal never revokes enrollment or deletes remote data.
        Ok(metadata)
    }
}

#[cfg(test)]
#[path = "environment_tests.rs"]
pub(crate) mod tests;
