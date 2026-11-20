use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use uuid::Uuid;

#[path = "environments.rs"]
pub mod environments;
#[path = "provider_transfer.rs"]
pub mod provider_transfer;
#[path = "server_setup.rs"]
pub mod server_setup;
static IDENTITY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    id: String,
    key: String,
}
trait IdentityStore: Send + Sync {
    fn read(&self) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, bytes: &[u8]) -> Result<(), String>;
}
struct KeychainIdentityStore;
impl IdentityStore for KeychainIdentityStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        #[cfg(target_os = "macos")]
        match security_framework::passwords::get_generic_password("dev.outpost.identity", "device")
        {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(error) => Err(format!(
                "Allow Outpost to access its existing device identity in Keychain: {error}"
            )),
        }
        #[cfg(not(target_os = "macos"))]
        Err("This build currently requires macOS Keychain".into())
    }
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            security_framework::passwords::set_generic_password(
                "dev.outpost.identity",
                "device",
                bytes,
            )
            .map_err(|e| format!("Keychain: {e}"))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = bytes;
            Err("This build currently requires macOS Keychain".into())
        }
    }
}
fn load_identity(store: &dyn IdentityStore) -> Result<Identity, String> {
    let _guard = IDENTITY_LOCK.lock().map_err(|_| "Identity lock failed")?;
    let stored: StoredIdentity = match store.read()? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
        None => {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            let stored = StoredIdentity {
                id: Uuid::new_v4().to_string(),
                key: STANDARD.encode(key),
            };
            store.write(&serde_json::to_vec(&stored).map_err(|e| e.to_string())?)?;
            stored
        }
    };
    Uuid::parse_str(&stored.id).map_err(|_| "Invalid device identity")?;
    let key: [u8; 32] = STANDARD
        .decode(stored.key)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "Invalid signing key")?;
    Ok(Identity {
        id: stored.id,
        key: SigningKey::from_bytes(&key),
    })
}
struct Identity {
    id: String,
    key: SigningKey,
}
struct Client {
    endpoint: String,
    identity: Option<Identity>,
    pending: Option<Value>,
}
pub struct State {
    client: Mutex<Client>,
    http: reqwest::Client,
    stream_http: reqwest::Client,
    directory: PathBuf,
    environment_id: Option<String>,
    mutation: std::sync::Arc<tokio::sync::Mutex<()>>,
    stream: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    removed: std::sync::atomic::AtomicBool,
    route_available: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    identity_store: Option<std::sync::Arc<dyn IdentityStore>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[cfg(test)]
thread_local! {
    static DIRECTORY_SYNC_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&std::path::Path) -> Result<(), String>>>> = std::cell::RefCell::new(None);
}
fn sync_directory(path: &std::path::Path) -> Result<(), String> {
    #[cfg(test)]
    DIRECTORY_SYNC_HOOK.with(|hook| -> Result<(), String> {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(path)?;
        }
        Ok(())
    })?;
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())
}
// Sync even an existing link: a prior mkdir may have succeeded before a failed barrier.
fn durable_directory(path: &std::path::Path) -> Result<bool, String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    let fresh = match builder.create(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => false,
        Err(e) => return Err(e.to_string()),
    };
    sync_directory(path.parent().ok_or("Missing directory parent")?)?;
    Ok(fresh)
}
fn private_write(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    sync_directory(path.parent().ok_or("Missing parent directory")?)
}

fn validate_endpoint(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Enter a valid server URL")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use HTTPS or localhost HTTP, without embedded credentials".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn legacy_endpoint(directory: &std::path::Path) -> Result<String, String> {
    match fs::read_to_string(directory.join("endpoint")) {
        Ok(value) if value.is_empty() => Ok(String::new()),
        Ok(value) => validate_endpoint(value.trim()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok("http://127.0.0.1:4318".into())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn build_stream_http(
    connect_timeout: Duration,
    read_timeout: Duration,
) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

impl State {
    pub fn mutation_gate(&self) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        self.mutation.clone()
    }
    pub fn new(directory: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let endpoint = legacy_endpoint(&directory)?;
        Ok(Self {
            client: Mutex::new(Client {
                endpoint,
                identity: None,
                pending: None,
            }),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            stream_http: build_stream_http(Duration::from_secs(15), Duration::from_secs(90))?,
            directory,
            environment_id: None,
            mutation: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            stream: Mutex::new(None),
            removed: std::sync::atomic::AtomicBool::new(false),
            route_available: std::sync::atomic::AtomicBool::new(true),
            #[cfg(test)]
            identity_store: None,
        })
    }
    fn identity(&self, client: &mut Client) -> Result<(), String> {
        if client.identity.is_some() {
            return Ok(());
        }
        #[cfg(test)]
        if let Some(store) = &self.identity_store {
            client.identity = Some(load_identity(store.as_ref())?);
            return Ok(());
        }
        client.identity = Some(load_identity(&KeychainIdentityStore)?);
        Ok(())
    }
    fn allow_mutation(&self) -> Result<(), String> {
        if self.environment_id.is_none() {
            environments::allow_legacy_mutation(&self.directory)?;
        }
        Ok(())
    }
    fn load_pending(&self, client: &mut Client) -> Result<(), String> {
        self.identity(client)?;
        let bytes = match fs::read(self.directory.join("pending.enc")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                client.pending = None;
                return Ok(());
            }
            Err(error) => return Err(format!("Cannot read pending command: {error}")),
        };
        if bytes.len() < 12 {
            return Err("Invalid pending command file".into());
        }
        let clear = Self::cipher(client.identity.as_ref().unwrap())
            .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
            .map_err(|_| "Cannot decrypt pending command; inspect before sending new commands")?;
        let envelope: Value =
            serde_json::from_slice(&clear).map_err(|_| "Invalid pending envelope")?;
        let expected_fields = if self.environment_id.is_some() {
            ["environmentId", "command"]
        } else {
            ["endpoint", "command"]
        };
        if envelope
            .as_object()
            .is_none_or(|v| v.len() != 2 || expected_fields.iter().any(|k| !v.contains_key(*k)))
        {
            return Err("Invalid pending envelope fields".into());
        }
        let command = &envelope["command"];
        if let Some(id) = &self.environment_id {
            if envelope["environmentId"].as_str() != Some(id)
                || command["environmentId"].as_str() != Some(id)
                || command["protocolVersion"] != 2
            {
                return Err("Pending command environment binding mismatch".into());
            }
        } else if validate_endpoint(
            envelope["endpoint"]
                .as_str()
                .ok_or("Invalid legacy pending endpoint")?,
        )? != validate_endpoint(&client.endpoint)?
            || command["protocolVersion"] != 1
        {
            return Err("Legacy pending command belongs to another server; resolve on its original endpoint".into());
        }
        self.validate_command(command)?;
        client.pending = Some(command.clone());
        Ok(())
    }
    fn validate_command(&self, command: &Value) -> Result<(), String> {
        let fields = [
            "protocolVersion",
            "commandId",
            "idempotencyKey",
            "aggregateId",
            "expectedRevision",
            "type",
            "payload",
        ];
        if command.as_object().is_none_or(|v| {
            v.len() != fields.len() + usize::from(self.environment_id.is_some())
                || fields.iter().any(|k| !v.contains_key(*k))
        }) {
            return Err("Invalid pending command fields".into());
        }
        for field in ["commandId", "idempotencyKey"] {
            environments::validate_id(
                command[field]
                    .as_str()
                    .ok_or("Invalid pending command ID")?,
            )?;
        }
        if command["expectedRevision"].as_u64().is_none()
            || !command["payload"].is_object()
            || command["aggregateId"].as_str().is_none()
            || command["type"].as_str().is_none()
        {
            return Err("Invalid pending command".into());
        }
        Ok(())
    }
    fn bind(&self, value: &mut Value) {
        if let Some(id) = &self.environment_id {
            value["protocolVersion"] = json!(2);
            value["environmentId"] = json!(id);
        }
    }
    fn verify_response(&self, response: &reqwest::Response) -> Result<(), String> {
        if let Some(id) = &self.environment_id {
            if response
                .headers()
                .get("x-outpost-environment-id")
                .and_then(|v| v.to_str().ok())
                != Some(id.as_str())
                || response
                    .headers()
                    .get("x-outpost-protocol-version")
                    .and_then(|v| v.to_str().ok())
                    != Some("2")
            {
                return Err("Server identity/protocol mismatch; response rejected".into());
            }
        }
        Ok(())
    }
    fn cipher(identity: &Identity) -> Aes256Gcm {
        let mut hash = Sha256::new();
        hash.update(b"outpost-desktop-pending-v1");
        hash.update(identity.key.to_bytes());
        Aes256Gcm::new(&hash.finalize())
    }
    fn persist_pending(&self, client: &Client) -> Result<(), String> {
        let path = self.directory.join("pending.enc");
        if let Some(command) = &client.pending {
            let identity = client
                .identity
                .as_ref()
                .ok_or("Device identity unavailable")?;
            let clear = serde_json::to_vec(&match &self.environment_id {
                Some(id) => json!({ "environmentId": id, "command": command }),
                None => json!({ "endpoint": client.endpoint, "command": command }),
            })
            .map_err(|e| e.to_string())?;
            let mut nonce = [0u8; 12];
            OsRng.fill_bytes(&mut nonce);
            let encrypted = Self::cipher(identity)
                .encrypt(Nonce::from_slice(&nonce), clear.as_ref())
                .map_err(|_| "Could not encrypt pending command")?;
            let mut bytes = nonce.to_vec();
            bytes.extend(encrypted);
            private_write(&path, &bytes)
        } else {
            match fs::remove_file(&path) {
                Ok(()) => {
                    fs::File::open(&self.directory)
                        .and_then(|f| f.sync_all())
                        .map_err(|e| e.to_string())?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            Ok(())
        }
    }
    fn prepare_request(
        &self,
        path: &str,
        mut value: Value,
        signed: bool,
    ) -> Result<reqwest::RequestBuilder, String> {
        if self.removed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Environment removed".into());
        }
        if !self.route_available.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Private SSH connection is unavailable; automatic recovery is managing this route.".into());
        }
        self.bind(&mut value);
        let path = if self.environment_id.is_some() {
            path.replacen("v1/", "v2/", 1)
        } else {
            path.to_string()
        };
        let (endpoint, body, signature) = {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
            if client.endpoint.is_empty() {
                return Err("No server connection is configured".into());
            }
            self.identity(&mut client)?;
            let identity = client
                .identity
                .as_ref()
                .ok_or("Device identity unavailable")?;
            value["deviceId"] = json!(identity.id);
            value["issuedAt"] = json!(now());
            let body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            let signature = STANDARD.encode(identity.key.sign(&body).to_bytes());
            (client.endpoint.clone(), body, signature)
        };
        let http = if path.ends_with("/stream") {
            &self.stream_http
        } else {
            &self.http
        };
        let mut request = http
            .post(format!("{endpoint}/{path}"))
            .header("content-type", "application/json")
            .body(body);
        if signed {
            request = request.header("x-outpost-signature", signature);
        }
        Ok(request)
    }
    async fn request(
        &self,
        path: &str,
        value: Value,
        signed: bool,
    ) -> Result<reqwest::Response, String> {
        self.send_request(self.prepare_request(path, value, signed)?)
            .await
    }
    async fn send_request(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, String> {
        let response = request
            .send()
            .await
            .map_err(|e| format!("Cannot reach your server. Check the private SSH tunnel. {e}"))?;
        self.verify_response(&response)?;
        Ok(response)
    }
    // Credential operations must never touch pending.enc or replayable commands.
    async fn agent_request(&self, payload: Value) -> Result<Value, String> {
        let _legacy_mutation = if self.environment_id.is_none() {
            Some(self.mutation.lock().await)
        } else {
            None
        };
        self.allow_mutation()?;
        let response = self
            .request(
                "v1/agent",
                json!({ "type": "agent", "payload": payload }),
                true,
            )
            .await
            .map_err(|_| "Provider request interrupted. Check status before trying again.")?;
        let status = response.status();
        if !status.is_success() {
            // Never reflect provider/HTTP error bodies into desktop diagnostics.
            return Err(format!(
                "Provider request failed (HTTP {}). Refresh status before retrying.",
                status.as_u16()
            ));
        }
        response
            .json()
            .await
            .map_err(|_| "Invalid provider response".into())
    }
    // Browser keystrokes are transient, never persisted or automatically retried.
    async fn browser_request(&self, mut payload: Value) -> Result<Value, String> {
        let _legacy_mutation = if self.environment_id.is_none() {
            Some(self.mutation.lock().await)
        } else {
            None
        };
        self.allow_mutation()?;
        if !payload.is_object() { return Err("Invalid browser request".into()); }
        payload["requestId"] = json!(Uuid::new_v4().to_string());
        let request = self.prepare_request("v1/browser", json!({ "type": "browser", "payload": payload }), true)?
            .timeout(Duration::from_secs(30));
        let response = self.send_request(request).await
            .map_err(|_| "Browser reply lost. Inspect the current page before acting again.")?;
        if !response.status().is_success() {
            return Err("Browser request rejected. Refresh the view and check control ownership before acting again.".into());
        }
        response.json().await.map_err(|_| "Invalid browser response. Inspect the current page before acting again.".into())
    }
    async fn enroll_device(
        &self,
        device_id: String,
        name: String,
        public_key: String,
    ) -> Result<Value, String> {
        let _mutation = self.mutation.lock().await;
        self.allow_mutation()?;
        Uuid::parse_str(&device_id).map_err(|_| "Enter the other device's UUID")?;
        if name.trim().is_empty() || name.chars().count() > 80 {
            return Err("Device name must contain 1–80 characters".into());
        }
        let key = STANDARD
            .decode(&public_key)
            .map_err(|_| "Enter a base64 public pairing key")?;
        if key.len() != 32 {
            return Err("Public pairing key must contain 32 bytes".into());
        }
        {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
            self.load_pending(&mut client)?;
            if client.pending.is_some() {
                return Err(
                    "Resolve the unknown pending command before enrolling another device".into(),
                );
            }
        }
        // The outer deviceId is the Keychain signer; the payload is the new device.
        // This endpoint has no command receipt: never automatically retry enrollment.
        let response = self.request("v1/pair-device", json!({ "type": "pair", "payload": {
            "deviceId": device_id, "name": name.trim(), "publicKey": public_key
        }}), true).await.map_err(|_| "Enrollment outcome unknown. Refresh trusted devices and verify the ID and key before trying again.")?;
        let status = response.status();
        let body: Value = response.json().await.map_err(|_| {
            "Enrollment response incomplete. Refresh trusted devices before trying again."
        })?;
        if !status.is_success() {
            return Err(format!(
                "Enrollment not confirmed: {}. Refresh trusted devices before trying again.",
                body["message"]
                    .as_str()
                    .unwrap_or("Server rejected enrollment")
            ));
        }
        Ok(body)
    }

    async fn submit(&self, command: Value) -> Result<Value, String> {
        let response = self.request("v1/commands", command.clone(), true).await?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|e| format!("Response incomplete; retry the same command. {e}"))?;
        if status.is_success() || status.is_client_error() {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
            if client.pending.is_some()
                && client.pending.as_ref().map(|v| &v["commandId"]) != Some(&command["commandId"])
            {
                return Err("Pending command changed; response cannot clear it".into());
            }
            let pending = client.pending.take();
            if let Err(error) = self.persist_pending(&client) {
                client.pending = pending;
                return Err(format!("Server replied, but the durable pending command could not be cleared. Retry the same operation after fixing storage: {error}"));
            }
        }
        if !status.is_success() {
            return Err(body["message"]
                .as_str()
                .unwrap_or("Server rejected the command")
                .to_string());
        }
        Ok(body)
    }
}

#[tauri::command]
pub fn connection_info(state: tauri::State<'_, State>) -> Result<Value, String> {
    let mut client = state.client.lock().map_err(|_| "Connection lock failed")?;
    state.load_pending(&mut client)?;
    let identity = client
        .identity
        .as_ref()
        .ok_or("Device identity unavailable")?;
    Ok(
        json!({ "endpoint": client.endpoint, "deviceId": identity.id, "publicKey": STANDARD.encode(identity.key.verifying_key().to_bytes()), "pending": client.pending.is_some(), "nativeSidebar": false }),
    )
}

#[tauri::command]
pub async fn set_endpoint(state: tauri::State<'_, State>, endpoint: String) -> Result<(), String> {
    state.set_endpoint(endpoint).await
}

#[tauri::command]
pub async fn clear_legacy_endpoint(state: tauri::State<'_, State>) -> Result<(), String> {
    state.clear_legacy_endpoint().await
}

impl State {
    async fn clear_legacy_endpoint(&self) -> Result<(), String> {
        let _mutation = self.mutation.lock().await;
        {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
            self.load_pending(&mut client)?;
            if client.pending.is_some() {
                return Err("Resolve the pending command before deleting this connection".into());
            }
            // An empty file records an explicit removal and suppresses the default route.
            private_write(&self.directory.join("endpoint"), b"")?;
            client.endpoint.clear();
        }
        self.cancel_stream()
    }

    async fn set_endpoint(&self, endpoint: String) -> Result<(), String> {
        let _mutation = self.mutation.lock().await;
        self.allow_mutation()?;
        let endpoint = validate_endpoint(&endpoint)?;
        let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
        self.load_pending(&mut client)?;
        if client.pending.is_some() {
            return Err("Resolve the pending command before switching servers".into());
        }
        if endpoint != client.endpoint && environments::has_saved_environments(&self.directory)? {
            return Err("Legacy endpoint changes are disabled after registering an environment; use verified environment registration for route changes".into());
        }
        private_write(&self.directory.join("endpoint"), endpoint.as_bytes())?;
        client.endpoint = endpoint;
        Ok(())
    }
}

#[tauri::command]
pub async fn stream_events(
    state: tauri::State<'_, State>,
    channel: tauri::ipc::Channel<Value>,
) -> Result<(), String> {
    state.bound_stream(channel).await
}

#[tauri::command]
pub fn disconnect(state: tauri::State<'_, State>) -> Result<(), String> {
    state.cancel_stream()
}

// Transfer packets and maintenance approval stay in the native broker, not generic React IPC.
fn public_management_request(payload: &Value) -> Result<(), String> {
    let kind = payload["type"].as_str().unwrap_or("");
    if matches!(kind, "transfer.prepare" | "transfer.export" | "transfer.apply")
        || (kind.starts_with("maintenance.") && kind != "maintenance.status") {
        return Err("Use the reviewed native server operation".into());
    }
    Ok(())
}
// Ephemeral credential path: never use persist_pending or command retry storage here.
#[tauri::command]
pub async fn agent_request(
    state: tauri::State<'_, State>,
    payload: Value,
) -> Result<Value, String> {
    public_management_request(&payload)?;
    state.agent_request(payload).await
}

#[tauri::command]
pub async fn browser_request(state: tauri::State<'_, State>, payload: Value) -> Result<Value, String> {
    state.browser_request(payload).await
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum QueryError {
    Message(String),
    Workspace { code: String, message: String },
}

impl QueryError {
    fn into_message(self) -> String {
        match self {
            Self::Message(message) | Self::Workspace { message, .. } => message,
        }
    }
}

impl From<String> for QueryError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&str> for QueryError {
    fn from(message: &str) -> Self {
        Self::Message(message.into())
    }
}

fn query_rejection(kind: &str, value: &Value, fallback: &str) -> QueryError {
    let message = value["message"].as_str().unwrap_or(fallback).to_owned();
    if matches!(kind, "workspace.files" | "workspace.read") {
        if let Some(code) = value["error"].as_str().filter(|code| !code.is_empty()) {
            return QueryError::Workspace {
                code: code.into(),
                message,
            };
        }
    }
    QueryError::Message(message)
}

#[tauri::command]
pub async fn query(
    state: tauri::State<'_, State>,
    kind: String,
    payload: Value,
) -> Result<Value, QueryError> {
    let response = state
        .request(
            "v1/query",
            json!({ "type": kind, "payload": payload }),
            true,
        )
        .await?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(query_rejection(&kind, &value, "Server query failed"));
    }
    Ok(value)
}

#[tauri::command]
pub async fn send_command(
    state: tauri::State<'_, State>,
    kind: String,
    id: String,
    revision: u64,
    payload: Value,
) -> Result<Value, String> {
    state.send_command(kind, id, revision, payload).await
}

#[tauri::command]
pub async fn retry_command(state: tauri::State<'_, State>) -> Result<Value, String> {
    state.retry_command().await
}

#[tauri::command]
pub async fn enroll_device(
    state: tauri::State<'_, State>,
    device_id: String,
    name: String,
    public_key: String,
) -> Result<Value, String> {
    state.enroll_device(device_id, name, public_key).await
}

impl State {
    async fn send_command(
        &self,
        kind: String,
        id: String,
        revision: u64,
        payload: Value,
    ) -> Result<Value, String> {
        let _mutation = self
            .mutation
            .try_lock()
            .map_err(|_| "A command operation is already in progress")?;
        self.allow_mutation()?;
        if self.removed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Environment removed".into());
        }
        let command = {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
            if client.endpoint.is_empty() {
                return Err("No server connection is configured".into());
            }
            self.load_pending(&mut client)?;
            if client.pending.is_some() {
                return Err(
                    "A previous command has an unknown outcome. Retry that command first.".into(),
                );
            }
            let mut command = json!({ "protocolVersion": 1, "commandId": Uuid::new_v4(), "idempotencyKey": Uuid::new_v4(), "aggregateId": id, "expectedRevision": revision, "type": kind, "payload": payload });
            self.bind(&mut command);
            self.validate_command(&command)?;
            client.pending = Some(command.clone());
            if let Err(error) = self.persist_pending(&client) {
                client.pending = None;
                return Err(format!(
                    "Command was not sent: could not save its encrypted retry envelope. {error}"
                ));
            }
            command
        };
        self.submit(command).await
    }

    async fn retry_command(&self) -> Result<Value, String> {
        let _mutation = self
            .mutation
            .try_lock()
            .map_err(|_| "A command operation is already in progress")?;
        self.allow_mutation()?;
        if self.removed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Environment removed".into());
        }
        let command = {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
            self.load_pending(&mut client)?;
            client
                .pending
                .clone()
                .ok_or("There is no pending command")?
        };
        self.submit(command).await
    }
}

#[tauri::command]
pub async fn pair(state: tauri::State<'_, State>, token: String) -> Result<(), String> {
    state.pair(token).await
}
impl State {
    async fn pair(&self, token: String) -> Result<(), String> {
        let _mutation = self.mutation.lock().await;
        self.allow_mutation()?;
        let mut body = {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
            self.identity(&mut client)?;
            let identity = client
                .identity
                .as_ref()
                .ok_or("Device identity unavailable")?;
            json!({ "deviceId": identity.id, "name": "Outpost", "publicKey": STANDARD.encode(identity.key.verifying_key().to_bytes()), "token": token.trim() })
        };
        self.bind(&mut body);
        let version = if self.environment_id.is_some() { 2 } else { 1 };
        // Bootstrap has a strict schema and deliberately does not include issuedAt.
        let endpoint = self
            .client
            .lock()
            .map_err(|_| "Connection lock failed")?
            .endpoint
            .clone();
        let response = self
            .http
            .post(format!("{endpoint}/v{version}/pair"))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        self.verify_response(&response)?;
        if !response.status().is_success() {
            let body: Value = response.json().await.map_err(|e| e.to_string())?;
            return Err(body["message"].as_str().unwrap_or("Pairing failed").into());
        }
        Ok(())
    }
}

async fn artifact_bytes(state: &State, id: &str, hash: &str) -> Result<Vec<u8>, String> {
    let response = state
        .request(
            "v1/artifact",
            json!({ "type": "download", "payload": { "artifactId": id } }),
            true,
        )
        .await?;
    if !response.status().is_success() {
        return Err("Artifact unavailable".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.len() > 64 * 1024 * 1024 || format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err("Artifact integrity check failed".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn artifact(
    state: tauri::State<'_, State>,
    id: String,
    hash: String,
) -> Result<String, String> {
    Ok(STANDARD.encode(artifact_bytes(&state, &id, &hash).await?))
}

#[tauri::command]
pub async fn save_artifact(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    id: String,
    hash: String,
    name: String,
) -> Result<String, String> {
    Uuid::parse_str(&id).map_err(|_| "Invalid artifact id")?;
    if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
        return Err("Invalid filename".into());
    }
    let directory = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?
        .join("Outpost")
        .join(&id);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(name);
    private_write(&path, &artifact_bytes(&state, &id, &hash).await?)?;
    Ok(path.to_string_lossy().into_owned())
}

const WORKSPACE_FILE_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceFile {
    path: String,
    name: String,
    text: String,
    size: u64,
    hash: String,
    modified_at: String,
}

fn validate_workspace_request(task_id: &str, path: &str, hash: &str) -> Result<(), String> {
    environments::validate_id(task_id).map_err(|_| "Invalid task UUID")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Expected a lowercase SHA256 hash".into());
    }
    if path.encode_utf16().count() > 1000
        || path
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':' | '%'))
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.len() > 255)
    {
        return Err("Invalid workspace path".into());
    }
    let name = path.rsplit('/').next().ok_or("Invalid filename")?;
    if name.ends_with(['.', ' ']) || name.contains(['<', '>', '"', '|', '?', '*']) {
        return Err("Invalid filename".into());
    }
    Ok(())
}

fn validate_workspace_file(
    value: Value,
    task_id: &str,
    path: &str,
    hash: &str,
) -> Result<WorkspaceFile, String> {
    validate_workspace_request(task_id, path, hash)?;
    let file: WorkspaceFile =
        serde_json::from_value(value).map_err(|_| "Invalid workspace file response")?;
    if file.path != path
        || Some(file.name.as_str()) != path.rsplit('/').next()
        || file.modified_at.is_empty()
        || file.modified_at.chars().any(char::is_control)
    {
        return Err("Invalid workspace file metadata".into());
    }
    if file.text.len() > WORKSPACE_FILE_LIMIT
        || file
            .text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err("Workspace download requires text of at most 1 MiB".into());
    }
    if file.size != file.text.len() as u64
        || file.hash != format!("{:x}", Sha256::digest(file.text.as_bytes()))
    {
        return Err("Workspace file integrity check failed".into());
    }
    if file.hash != hash {
        return Err(
            "Workspace file changed since preview; preview it again before downloading".into(),
        );
    }
    Ok(file)
}

async fn workspace_file(
    state: &State,
    task_id: &str,
    path: &str,
    hash: &str,
) -> Result<WorkspaceFile, String> {
    validate_workspace_request(task_id, path, hash)?;
    let value = environments::query_value(
        state,
        "workspace.read".into(),
        json!({ "taskId": task_id, "path": path }),
    )
    .await?;
    validate_workspace_file(value, task_id, path, hash)
}

fn save_workspace_snapshot(
    downloads: &std::path::Path,
    snapshot: WorkspaceFile,
) -> Result<String, String> {
    use std::io::Write;
    let name: String = snapshot
        .name
        .chars()
        .take(180)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = downloads.join(format!("{}-{name}", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    if let Err(error) = file
        .write_all(snapshot.text.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&path);
        return Err(error.to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn save_workspace_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    task_id: String,
    path: String,
    hash: String,
) -> Result<String, String> {
    let owner = state.inner();
    let snapshot = workspace_file(owner, &task_id, &path, &hash).await?;
    save_workspace_snapshot(
        &app.path().download_dir().map_err(|e| e.to_string())?,
        snapshot,
    )
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web links can be opened".into());
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("/usr/bin/open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const WORKSPACE_TASK: &str = "11111111-1111-4111-8111-111111111111";
    const WORKSPACE_PATH: &str = "reports/summary.txt";

    #[test]
    fn query_rejection_preserves_workspace_unknown_query_codes() {
        for kind in ["workspace.files", "workspace.read"] {
            for fallback in ["Query rejected", "Server query failed"] {
                let error = query_rejection(
                    kind,
                    &json!({
                        "error":"unknown_query", "message":"Unsupported query", "details":"not exposed"
                    }),
                    fallback,
                );
                assert_eq!(
                    serde_json::to_value(error).unwrap(),
                    json!({
                        "code":"unknown_query", "message":"Unsupported query"
                    })
                );
            }
        }
    }

    #[test]
    fn query_rejection_preserves_other_workspace_codes_without_matching_messages() {
        for kind in ["workspace.files", "workspace.read"] {
            for (code, message) in [
                ("not_found", "Unsupported query"),
                ("invalid_request", "Request failed validation"),
                ("unknown_query", "A different server message"),
            ] {
                let error = query_rejection(
                    kind,
                    &json!({"error":code,"message":message}),
                    "Query rejected",
                );
                assert_eq!(
                    serde_json::to_value(error).unwrap(),
                    json!({"code":code,"message":message})
                );
            }
        }
    }

    #[test]
    fn query_rejection_keeps_nonworkspace_errors_as_strings() {
        for kind in [
            "runtime",
            "environment",
            "snapshot",
            "workspace.write",
            "workspace.read.more",
        ] {
            let error = query_rejection(
                kind,
                &json!({"error":"unknown_query","message":"Unsupported query"}),
                "Query rejected",
            );
            assert_eq!(
                serde_json::to_value(error).unwrap(),
                json!("Unsupported query")
            );
        }
        for fallback in ["Query rejected", "Server query failed"] {
            let error = query_rejection("runtime", &json!({"error":"unknown_query"}), fallback);
            assert_eq!(serde_json::to_value(error).unwrap(), json!(fallback));
        }
    }

    #[test]
    fn query_rejection_keeps_missing_codes_and_local_failures_as_strings() {
        for kind in ["workspace.files", "workspace.read"] {
            for code in [Value::Null, json!(42), json!("")] {
                let error = query_rejection(
                    kind,
                    &json!({"error":code,"message":"Unsupported query"}),
                    "Query rejected",
                );
                assert_eq!(
                    serde_json::to_value(error).unwrap(),
                    json!("Unsupported query")
                );
            }
            let error = query_rejection(kind, &json!({"error":"unknown_query"}), "Query rejected");
            assert_eq!(
                serde_json::to_value(error).unwrap(),
                json!({"code":"unknown_query","message":"Query rejected"})
            );
        }
        for error in [
            QueryError::from("Invalid query response"),
            QueryError::from(String::from("Request failed")),
        ] {
            assert!(serde_json::to_value(error).unwrap().is_string());
        }
    }

    #[test]
    fn query_rejection_internal_callers_keep_the_original_message() {
        for kind in ["workspace.read", "workspace.files", "environment"] {
            let error = query_rejection(
                kind,
                &json!({"error":"unknown_query","message":"Unsupported query"}),
                "Query rejected",
            );
            assert_eq!(error.into_message(), "Unsupported query");
        }
    }

    fn workspace_response(text: &str) -> Value {
        json!({
            "path": WORKSPACE_PATH,
            "name": "summary.txt",
            "text": text,
            "size": text.len(),
            "hash": format!("{:x}", Sha256::digest(text.as_bytes())),
            "modifiedAt": "2026-11-17T00:00:00.000Z"
        })
    }

    #[test]
    fn workspace_validation_preserves_exact_utf8_bytes_and_limits() {
        for text in [
            String::new(),
            "\u{feff}Résumé 🦀\r\n\t".into(),
            "é".repeat(WORKSPACE_FILE_LIMIT / 2),
        ] {
            let value = workspace_response(&text);
            let hash = value["hash"].as_str().unwrap().to_owned();
            let file =
                validate_workspace_file(value, WORKSPACE_TASK, WORKSPACE_PATH, &hash).unwrap();
            assert_eq!(file.text.as_bytes(), text.as_bytes());
        }
        let value = workspace_response(&"é".repeat(WORKSPACE_FILE_LIMIT / 2 + 1));
        let hash = value["hash"].as_str().unwrap().to_owned();
        assert!(validate_workspace_file(value, WORKSPACE_TASK, WORKSPACE_PATH, &hash).is_err());
    }

    #[test]
    fn workspace_validation_rejects_invalid_requests_and_malicious_names() {
        let hash = "a".repeat(64);
        for task in ["", "../task", "not-a-uuid"] {
            assert!(validate_workspace_request(task, WORKSPACE_PATH, &hash).is_err());
        }
        for hash in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
        ] {
            assert!(validate_workspace_request(WORKSPACE_TASK, WORKSPACE_PATH, &hash).is_err());
        }
        for path in [
            "",
            "/absolute.txt",
            "a/../b",
            "./a",
            "a//b",
            "a/",
            "a\\b",
            "C:file",
            "%2e%2e/file",
            "a\0b",
            "a\nb",
            "..",
            ".",
            "file.",
            "file ",
            "a<b",
            "a>b",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
        ] {
            assert!(
                validate_workspace_request(WORKSPACE_TASK, path, &hash).is_err(),
                "{path:?}"
            );
        }
        assert!(validate_workspace_request(WORKSPACE_TASK, &"a".repeat(256), &hash).is_err());
        assert!(validate_workspace_request(WORKSPACE_TASK, &"a/".repeat(501), &hash).is_err());
    }

    #[test]
    fn workspace_validation_requires_exact_response_fields_and_types() {
        let original = workspace_response("hello");
        let hash = original["hash"].as_str().unwrap();
        for field in ["path", "name", "text", "size", "hash", "modifiedAt"] {
            let mut value = original.clone();
            value.as_object_mut().unwrap().remove(field);
            assert!(
                validate_workspace_file(value, WORKSPACE_TASK, WORKSPACE_PATH, hash).is_err(),
                "missing {field}"
            );
            let mut value = original.clone();
            value[field] = Value::Null;
            assert!(
                validate_workspace_file(value, WORKSPACE_TASK, WORKSPACE_PATH, hash).is_err(),
                "null {field}"
            );
        }
        for (field, bad) in [
            ("extra", json!(true)),
            ("path", json!("other/summary.txt")),
            ("name", json!("../summary.txt")),
            ("name", json!("other.txt")),
            ("name", json!("summary.txt\0")),
            ("text", json!(42)),
            ("size", json!("5")),
            ("size", json!(-1)),
            ("size", json!(5.0)),
            ("modifiedAt", json!(42)),
            ("modifiedAt", json!("")),
        ] {
            let mut value = original.clone();
            value[field] = bad;
            assert!(
                validate_workspace_file(value, WORKSPACE_TASK, WORKSPACE_PATH, hash).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn workspace_validation_rejects_tampering_and_stale_preview() {
        let original = workspace_response("é");
        let hash = original["hash"].as_str().unwrap();
        for (field, bad) in [
            ("text", json!("different")),
            ("size", json!(1)),
            ("hash", json!("0".repeat(64))),
            ("hash", json!(hash.to_uppercase())),
        ] {
            let mut value = original.clone();
            value[field] = bad;
            assert!(validate_workspace_file(value, WORKSPACE_TASK, WORKSPACE_PATH, hash).is_err());
        }
        let changed = workspace_response("updated");
        assert!(
            validate_workspace_file(changed, WORKSPACE_TASK, WORKSPACE_PATH, hash)
                .err()
                .unwrap()
                .contains("changed since preview")
        );
        for text in ["binary\0", "escape\u{1b}", "delete\u{7f}", "control\u{85}"] {
            let value = workspace_response(text);
            let hash = value["hash"].as_str().unwrap().to_owned();
            assert!(validate_workspace_file(value, WORKSPACE_TASK, WORKSPACE_PATH, &hash).is_err());
        }
    }

    #[test]
    fn workspace_snapshot_download_uses_unique_sanitized_names_and_verified_bytes() {
        let downloads =
            std::env::temp_dir().join(format!("outpost-workspace-test-{}", Uuid::new_v4()));
        fs::create_dir(&downloads).unwrap();
        let name = "résumé report.txt";
        let mut value = workspace_response("\u{feff}hello\r\n");
        value["path"] = json!(format!("reports/{name}"));
        value["name"] = json!(name);
        let hash = value["hash"].as_str().unwrap();
        let mut paths = Vec::new();
        for _ in 0..2 {
            let file = validate_workspace_file(
                value.clone(),
                WORKSPACE_TASK,
                value["path"].as_str().unwrap(),
                hash,
            )
            .unwrap();
            let path = PathBuf::from(save_workspace_snapshot(&downloads, file).unwrap());
            assert_eq!(path.parent(), Some(downloads.as_path()));
            let filename = path.file_name().unwrap().to_str().unwrap();
            assert!(Uuid::parse_str(&filename[..36]).is_ok());
            assert!(filename.ends_with("-r_sum__report.txt"));
            assert_eq!(fs::read(&path).unwrap(), "\u{feff}hello\r\n".as_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            paths.push(path);
        }
        assert_ne!(paths[0], paths[1]);
        assert_eq!(fs::read_dir(&downloads).unwrap().count(), 2);
        fs::remove_dir_all(downloads).unwrap();
    }

    #[test]
    fn workspace_read_uses_authenticated_query_and_propagates_errors() {
        tauri::async_runtime::block_on(async {
            let value = workspace_response("hello");
            let hash = value["hash"].as_str().unwrap().to_owned();
            for (status, response, expected_error) in [
                ("200 OK", value, None),
                (
                    "403 Forbidden",
                    json!({"message": "workspace_denied"}),
                    Some("workspace_denied"),
                ),
                (
                    "200 OK",
                    json!({"message": "workspace_unavailable"}),
                    Some("Invalid workspace file response"),
                ),
                (
                    "200 OK",
                    workspace_response("changed"),
                    Some("changed since preview"),
                ),
            ] {
                let (state, request) = fixture(status, response);
                let result = workspace_file(&state, WORKSPACE_TASK, WORKSPACE_PATH, &hash).await;
                if let Some(error) = expected_error {
                    assert!(result.err().unwrap().contains(error));
                } else {
                    assert_eq!(result.unwrap().text, "hello");
                }
                let (headers, body) = request.join().unwrap();
                assert!(headers.starts_with("POST /v1/query HTTP/1.1"));
                assert_eq!(body["type"], "workspace.read");
                assert_eq!(
                    body["payload"],
                    json!({"taskId": WORKSPACE_TASK, "path": WORKSPACE_PATH})
                );
                assert_eq!(fs::read_dir(&state.directory).unwrap().count(), 0);
                fs::remove_dir_all(state.directory).unwrap();
            }
        });
    }

    // Loopback-only fixtures use a fixed ephemeral identity, never macOS Keychain.
    fn fixture(status: &str, reply: Value) -> (State, std::thread::JoinHandle<(String, Value)>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let status = status.to_string();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            let (header_end, length) = loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap()
                        .parse()
                        .unwrap();
                    break (end + 4, length);
                }
            };
            while bytes.len() < header_end + length {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let body = &bytes[header_end..header_end + length];
            let signature = headers
                .lines()
                .find_map(|line| line.strip_prefix("x-outpost-signature: "))
                .unwrap();
            let signature =
                ed25519_dalek::Signature::from_slice(&STANDARD.decode(signature).unwrap()).unwrap();
            SigningKey::from_bytes(&[7; 32])
                .verifying_key()
                .verify_strict(body, &signature)
                .unwrap();
            let value = serde_json::from_slice(body).unwrap();
            let reply = reply.to_string();
            write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            (headers, value)
        });
        let directory =
            std::env::temp_dir().join(format!("outpost-administration-test-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let state = State::new(directory).unwrap();
        {
            let mut client = state.client.lock().unwrap();
            client.endpoint = endpoint;
            client.identity = Some(Identity {
                id: "11111111-1111-4111-8111-111111111111".into(),
                key: SigningKey::from_bytes(&[7; 32]),
            });
        }
        (state, handle)
    }

    #[test]
    fn enrollment_uses_authenticated_pair_device_route_and_distinct_target() {
        tauri::async_runtime::block_on(async {
            let target = "22222222-2222-4222-8222-222222222222";
            let (state, request) = fixture(
                "200 OK",
                json!({ "id": target, "kind": "device", "revision": 1 }),
            );
            let result = state
                .enroll_device(target.into(), "Other Mac".into(), STANDARD.encode([9; 32]))
                .await
                .unwrap();
            assert_eq!(result["id"], target);
            let (headers, body) = request.join().unwrap();
            assert!(headers.starts_with("POST /v1/pair-device HTTP/1.1"));
            assert_eq!(body["deviceId"], "11111111-1111-4111-8111-111111111111");
            assert_eq!(body["type"], "pair");
            assert_eq!(
                body["payload"],
                json!({ "deviceId": target, "name": "Other Mac", "publicKey": STANDARD.encode([9; 32]) })
            );
            assert!(body["issuedAt"].as_u64().is_some());
            fs::remove_dir_all(state.directory).unwrap();
        });
    }

    #[test]
    fn enrollment_rejection_does_not_report_success() {
        tauri::async_runtime::block_on(async {
            for message in ["revoked_device", "revision_conflict"] {
                let (state, request) = fixture("409 Conflict", json!({ "message": message }));
                let error = state
                    .enroll_device(
                        Uuid::new_v4().to_string(),
                        "Other Mac".into(),
                        STANDARD.encode([9; 32]),
                    )
                    .await
                    .unwrap_err();
                assert!(error.contains(message));
                request.join().unwrap();
                fs::remove_dir_all(state.directory).unwrap();
            }
        });
    }

    #[test]
    fn administration_commands_sign_expected_revision_and_preserve_unknown_pending() {
        tauri::async_runtime::block_on(async {
            for (kind, payload, status) in [
                ("device.revoke", json!({}), "409 Conflict"),
                (
                    "recovery.resume",
                    json!({"acknowledged": true}),
                    "500 Internal Server Error",
                ),
            ] {
                let (state, request) = fixture(status, json!({"message": "revision_conflict"}));
                let command = json!({ "protocolVersion": 1, "commandId": Uuid::new_v4(), "idempotencyKey": Uuid::new_v4(), "type": kind, "aggregateId": if kind == "recovery.resume" { "server" } else { "22222222-2222-4222-8222-222222222222" }, "expectedRevision": 7, "payload": payload });
                state.client.lock().unwrap().pending = Some(command.clone());
                assert!(state.submit(command.clone()).await.is_err());
                let (headers, body) = request.join().unwrap();
                assert!(headers.starts_with("POST /v1/commands HTTP/1.1"));
                assert_eq!(body["type"], kind);
                assert_eq!(body["aggregateId"], command["aggregateId"]);
                assert_eq!(body["expectedRevision"], 7);
                assert_eq!(body["payload"], payload);
                assert_eq!(body["idempotencyKey"], command["idempotencyKey"]);
                if status.starts_with("500") {
                    assert_eq!(state.client.lock().unwrap().pending, Some(command));
                    state
                        .persist_pending(&state.client.lock().unwrap())
                        .unwrap();
                    let error = state
                        .enroll_device(
                            Uuid::new_v4().to_string(),
                            "Other Mac".into(),
                            STANDARD.encode([9; 32]),
                        )
                        .await
                        .unwrap_err();
                    assert!(error.contains("pending command"));
                } else {
                    assert!(state.client.lock().unwrap().pending.is_none());
                }
                fs::remove_dir_all(state.directory).unwrap();
            }
        });
    }

    #[test]
    fn provider_requests_are_signed_ephemeral_and_errors_do_not_echo_credentials() {
        tauri::async_runtime::block_on(async {
            for status in ["200 OK", "400 Bad Request", "500 Internal Server Error"] {
                let (state, request) = fixture(
                    status,
                    if status.starts_with("200") {
                        json!({ "state": "running" })
                    } else {
                        json!({ "message": "synthetic-secret-never-persist" })
                    },
                );
                let pending = json!({ "idempotencyKey": "unrelated-task" });
                state.client.lock().unwrap().pending = Some(pending.clone());
                let payload = json!({ "type": "login.answer", "flowId": "synthetic", "promptId": "step", "value": "synthetic-secret-never-persist" });
                let result = state.agent_request(payload.clone()).await;
                if status.starts_with("200") {
                    assert_eq!(result.unwrap()["state"], "running");
                } else {
                    assert!(!result
                        .unwrap_err()
                        .contains("synthetic-secret-never-persist"));
                }
                let (headers, body) = request.join().unwrap();
                assert!(headers.starts_with("POST /v1/agent HTTP/1.1"));
                assert_eq!(body["type"], "agent");
                assert_eq!(body["payload"], payload);
                assert!(body["issuedAt"].as_u64().is_some());
                assert_eq!(state.client.lock().unwrap().pending, Some(pending));
                assert_eq!(fs::read_dir(&state.directory).unwrap().count(), 0);
                fs::remove_dir_all(state.directory).unwrap();
            }
        });
    }

    #[test]
    fn browser_input_is_signed_transient_and_never_echoes_private_text() {
        tauri::async_runtime::block_on(async {
            for status in ["200 OK", "409 Conflict", "500 Internal Server Error"] {
                let secret = "synthetic-browser-input-not-for-logs";
                let (state, request) = fixture(status, json!({ "applied": true, "message": secret }));
                let pending = json!({ "idempotencyKey": "unrelated-task" });
                state.client.lock().unwrap().pending = Some(pending.clone());
                let result = state.browser_request(json!({ "type": "input", "taskId": Uuid::new_v4(),
                    "epoch": Uuid::new_v4(), "leaseId": Uuid::new_v4(), "frameId": Uuid::new_v4(),
                    "input": { "action": "text", "text": secret } })).await;
                if status.starts_with("200") { assert_eq!(result.unwrap()["applied"], true); }
                else { assert!(!result.unwrap_err().contains(secret)); }
                let (headers, body) = request.join().unwrap();
                assert!(headers.starts_with("POST /v1/browser HTTP/1.1"));
                assert_eq!(body["payload"]["input"]["text"], secret);
                assert!(Uuid::parse_str(body["payload"]["requestId"].as_str().unwrap()).is_ok());
                assert_eq!(state.client.lock().unwrap().pending, Some(pending));
                assert_eq!(fs::read_dir(&state.directory).unwrap().count(), 0);
                fs::remove_dir_all(state.directory).unwrap();
            }
        });
    }

    #[test]
    fn private_endpoint_validation() {
        assert!(validate_endpoint("http://127.0.0.1:4318").is_ok());
        assert!(validate_endpoint("https://outpost.example.com").is_ok());
        assert!(validate_endpoint("http://192.168.1.37:4318").is_err());
        assert!(validate_endpoint("https://user:secret@example.com").is_err());
        assert!(validate_endpoint("file:///etc/passwd").is_err());
    }
    #[test]
    #[ignore = "Uses the owner's paired Keychain identity and live private server"]
    fn live_signed_client_roundtrip() {
        assert_eq!(std::env::var("OUTPOST_LIVE_CLIENT").as_deref(), Ok("1"));
        tauri::async_runtime::block_on(async {
            let directory =
                std::env::temp_dir().join(format!("outpost-client-check-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            let state = State::new(directory.clone()).unwrap();
            let task_id = Uuid::new_v4().to_string();
            let mut response = state
                .request(
                    "v1/stream",
                    json!({ "type": "subscribe", "payload": {} }),
                    true,
                )
                .await
                .unwrap();
            assert!(response.status().is_success());
            let streamed_task = task_id.clone();
            let mut stream_proof = Some(tauri::async_runtime::spawn(async move {
                let mut decoder = crate::sse::Decoder::default();
                let (mut text, mut thinking, mut tools) = (0usize, 0usize, 0usize);
                while let Some(bytes) = response.chunk().await.unwrap() {
                    for frame in decoder.push(&bytes).unwrap() {
                        let record = &frame["record"];
                        if frame["type"] == "live" && record["data"]["taskId"] == streamed_task {
                            if record["kind"] == "message" {
                                if !record["data"]["text"].as_str().unwrap_or("").is_empty() {
                                    text += 1;
                                }
                                if !record["data"]["thinking"].as_str().unwrap_or("").is_empty() {
                                    thinking += 1;
                                }
                            }
                            if record["kind"] == "tool_stream" {
                                tools += 1;
                            }
                        }
                        if frame["type"] == "records"
                            && frame["records"].as_array().is_some_and(|rows| {
                                rows.iter().any(|record| {
                                    record["kind"] == "task"
                                        && record["id"] == streamed_task
                                        && record["data"]["state"] == "verifying"
                                })
                            })
                        {
                            return (text, thinking, tools);
                        }
                    }
                }
                (text, thinking, tools)
            }));
            let make = |kind: &str, revision: u64, payload: Value| json!({ "protocolVersion": 1, "commandId": Uuid::new_v4(), "idempotencyKey": Uuid::new_v4(), "aggregateId": task_id, "expectedRevision": revision, "type": kind, "payload": payload });
            let command = make(
                "task.create",
                0,
                json!({ "profile": "code", "mode": "full_control", "goal": "Tauri desktop connection verification. Use outpost_action file.write to create tauri-client-check.txt containing TAURI_CONNECTION_OK with expectedHash null. Then use command.run with argv [\"/bin/bash\",\"-lc\",\"cat tauri-client-check.txt\"] and cwd \".\". Report the observed output. Do not perform any other changes." }),
            );
            {
                let mut client = state.client.lock().unwrap();
                state.identity(&mut client).unwrap();
                client.pending = Some(command.clone());
                state.persist_pending(&client).unwrap();
            }
            let created = state.submit(command.clone()).await.unwrap();
            assert_eq!(created["id"], task_id);
            // The same idempotency key must return the original result, not duplicate the task.
            assert_eq!(state.submit(command).await.unwrap(), created);
            let mut followed_up = false;
            for _ in 0..120 {
                std::thread::sleep(Duration::from_secs(2));
                let response = state
                    .request(
                        "v1/query",
                        json!({ "type": "snapshot", "payload": {} }),
                        true,
                    )
                    .await
                    .unwrap();
                assert!(response.status().is_success());
                let snapshot: Value = response.json().await.unwrap();
                let records = snapshot["records"].as_array().unwrap();
                let task = records
                    .iter()
                    .find(|r| r["kind"] == "task" && r["id"] == task_id)
                    .unwrap();
                let status = task["data"]["state"].as_str().unwrap();
                assert!(
                    !["interrupted", "failed", "waiting_for_capacity"].contains(&status),
                    "Task failed: {}",
                    task["data"]["blocker"]
                );
                if status == "verifying" {
                    let actions: Vec<_> = records
                        .iter()
                        .filter(|r| r["kind"] == "action" && r["data"]["taskId"] == task_id)
                        .collect();
                    assert!(actions.iter().any(|r| r["data"]["tool"] == "command.run"
                        && r["data"]["result"]["exitCode"] == 0
                        && r["data"]["result"]["stdout"]
                            .as_str()
                            .unwrap_or("")
                            .contains("TAURI_CONNECTION_OK")));
                    if !followed_up {
                        let (text, thinking, tools) = stream_proof.take().unwrap().await.unwrap();
                        assert!(text > 0 && thinking > 0 && tools > 0, "Missing live stream channels: text={text}, thinking={thinking}, tools={tools}");
                        println!("Real Rust SSE decoder: {text} text, {thinking} thinking and {tools} tool frames received before completion");
                        state.submit(make("task.steer", task["revision"].as_u64().unwrap(), json!({ "text": "Verify session continuity: use file.read to read tauri-client-check.txt and report the exact observed content. Do not rewrite it or perform other actions." }))).await.unwrap();
                        followed_up = true;
                    } else if actions.iter().any(|r| r["data"]["tool"] == "file.read") {
                        println!("Live Rust transport: signed task, idempotent retry, two Pi turns and {} actions verified. Task {}", actions.len(), task_id);
                        fs::remove_dir_all(directory).unwrap();
                        return;
                    }
                }
            }
            panic!("Timed out: inspect task {task_id} before retrying");
        });
    }

    #[test]
    fn encrypted_pending_requires_the_original_key() {
        let identity = Identity {
            id: Uuid::new_v4().to_string(),
            key: SigningKey::from_bytes(&[7; 32]),
        };
        let nonce = Nonce::from_slice(&[3; 12]);
        let bytes = State::cipher(&identity)
            .encrypt(nonce, b"private command".as_ref())
            .unwrap();
        assert_eq!(
            State::cipher(&identity)
                .decrypt(nonce, bytes.as_ref())
                .unwrap(),
            b"private command"
        );
        let other = Identity {
            id: Uuid::new_v4().to_string(),
            key: SigningKey::from_bytes(&[8; 32]),
        };
        assert!(State::cipher(&other)
            .decrypt(nonce, bytes.as_ref())
            .is_err());
    }

    #[test]
    fn sse_stream_uses_read_timeout_without_total_body_timeout() {
        use std::io::{Read, Write};
        tauri::async_runtime::block_on(async {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                let (header_end, length) = loop {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(str::to_owned)
                            })
                            .unwrap()
                            .parse()
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while bytes.len() < header_end + length {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                }
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\n"
                )
                .unwrap();
                let send_chunk = |socket: &mut std::net::TcpStream, payload: &str| {
                    write!(socket, "{:x}\r\n{payload}\r\n", payload.len()).unwrap();
                    socket.flush().unwrap();
                };
                send_chunk(
                    &mut socket,
                    concat!(r#"data: {"type":"snapshot","cursor":1,"records":[],"live":[]}"#, "\n\n"),
                );
                // Exceed the 180ms read_timeout in total elapsed time (~350ms) using keepalive comments.
                for _ in 0..5 {
                    std::thread::sleep(Duration::from_millis(70));
                    send_chunk(&mut socket, ": keepalive\n\n");
                }
                send_chunk(
                    &mut socket,
                    concat!(r#"data: {"type":"records","cursor":2,"records":[]}"#, "\n\n"),
                );
                // Hold the socket open silently so the client's idle read_timeout triggers.
                std::thread::sleep(Duration::from_millis(450));
            });

            let directory =
                std::env::temp_dir().join(format!("outpost-stream-timeout-test-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            let mut state = State::new(directory).unwrap();
            state.stream_http =
                build_stream_http(Duration::from_secs(5), Duration::from_millis(180)).unwrap();
            {
                let mut client = state.client.lock().unwrap();
                client.endpoint = endpoint;
                client.identity = Some(Identity {
                    id: "11111111-1111-4111-8111-111111111111".into(),
                    key: SigningKey::from_bytes(&[7; 32]),
                });
            }

            let started = std::time::Instant::now();
            let mut response = state
                .request(
                    "v1/stream",
                    json!({ "type": "subscribe", "payload": {} }),
                    true,
                )
                .await
                .unwrap();
            assert!(response.status().is_success());
            let mut decoder = crate::sse::Decoder::default();
            let mut frames = Vec::new();
            let mut timed_out = false;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => frames.extend(decoder.push(&chunk).unwrap()),
                    Ok(None) => break,
                    Err(err) => {
                        assert!(err.is_timeout() || err.to_string().contains("timed out"), "unexpected stream error: {err}");
                        timed_out = true;
                        break;
                    }
                }
            }
            assert!(
                started.elapsed() >= Duration::from_millis(300),
                "stream must survive beyond read_timeout while keepalives arrive"
            );
            assert_eq!(frames.len(), 2);
            assert_eq!(frames[0]["type"], "snapshot");
            assert_eq!(frames[1]["type"], "records");
            assert!(timed_out, "idle stream must fail once read_timeout elapses");

            server.join().unwrap();
            fs::remove_dir_all(&state.directory).unwrap();
        });
    }
}
