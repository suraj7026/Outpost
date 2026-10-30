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

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    id: String,
    key: String,
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
    directory: PathBuf,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn private_write(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
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
    Ok(value.trim_end_matches('/').to_string())
}

impl State {
    pub fn new(directory: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let endpoint = fs::read_to_string(directory.join("endpoint"))
            .ok()
            .and_then(|s| validate_endpoint(s.trim()).ok())
            .unwrap_or_else(|| "http://127.0.0.1:4318".into());
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
            directory,
        })
    }
    fn identity(&self, client: &mut Client) -> Result<(), String> {
        if client.identity.is_some() {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            use security_framework::passwords::{get_generic_password, set_generic_password};
            let stored: StoredIdentity = match get_generic_password("dev.outpost.identity", "device") {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
                Err(error) if error.code() == -25300 => {
                    let mut key = [0u8; 32]; OsRng.fill_bytes(&mut key);
                    let identity = StoredIdentity { id: Uuid::new_v4().to_string(), key: STANDARD.encode(key) };
                    set_generic_password("dev.outpost.identity", "device", &serde_json::to_vec(&identity).map_err(|e| e.to_string())?).map_err(|e| format!("Keychain: {e}"))?;
                    identity
                },
                Err(error) => return Err(format!("Allow Outpost Desktop to access its existing device identity in Keychain: {error}")),
            };
            Uuid::parse_str(&stored.id).map_err(|_| "Invalid device identity")?;
            let key: [u8; 32] = STANDARD
                .decode(stored.key)
                .map_err(|e| e.to_string())?
                .try_into()
                .map_err(|_| "Invalid signing key")?;
            let identity = Identity {
                id: stored.id,
                key: SigningKey::from_bytes(&key),
            };
            if let Ok(bytes) = fs::read(self.directory.join("pending.enc")) {
                if bytes.len() < 12 {
                    return Err("Pending command file is invalid; do not retry blindly".into());
                }
                let cipher = Self::cipher(&identity);
                let clear = cipher
                    .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
                    .map_err(|_| {
                        "Cannot decrypt pending command; inspect before sending new commands"
                    })?;
                let pending: Value = serde_json::from_slice(&clear).map_err(|e| e.to_string())?;
                if pending["endpoint"].as_str() != Some(&client.endpoint) {
                    return Err("Pending command belongs to another server".into());
                }
                client.pending = Some(pending["command"].clone());
            }
            client.identity = Some(identity);
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("This build currently requires macOS Keychain".into())
        }
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
            let clear =
                serde_json::to_vec(&json!({ "endpoint": client.endpoint, "command": command }))
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
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
    async fn request(
        &self,
        path: &str,
        mut value: Value,
        signed: bool,
    ) -> Result<reqwest::Response, String> {
        let (endpoint, body, signature) = {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
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
        let mut request = self
            .http
            .post(format!("{endpoint}/{path}"))
            .header("content-type", "application/json")
            .body(body);
        if path == "v1/stream" {
            request = request.timeout(Duration::from_secs(90));
        }
        if signed {
            request = request.header("x-outpost-signature", signature);
        }
        request
            .send()
            .await
            .map_err(|e| format!("Cannot reach your server. Check the private SSH tunnel. {e}"))
    }
    async fn submit(&self, command: Value) -> Result<Value, String> {
        let response = self.request("v1/commands", command, true).await?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|e| format!("Response incomplete; retry the same command. {e}"))?;
        if status.is_success() || status.is_client_error() {
            let mut client = self.client.lock().map_err(|_| "Connection lock failed")?;
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
    state.identity(&mut client)?;
    let identity = client
        .identity
        .as_ref()
        .ok_or("Device identity unavailable")?;
    Ok(
        json!({ "endpoint": client.endpoint, "deviceId": identity.id, "publicKey": STANDARD.encode(identity.key.verifying_key().to_bytes()), "pending": client.pending.is_some(), "nativeSidebar": cfg!(target_os = "macos") }),
    )
}

#[tauri::command]
pub fn set_endpoint(state: tauri::State<'_, State>, endpoint: String) -> Result<(), String> {
    let endpoint = validate_endpoint(&endpoint)?;
    let mut client = state.client.lock().map_err(|_| "Connection lock failed")?;
    state.identity(&mut client)?;
    if client.pending.is_some() {
        return Err("Resolve the pending command before switching servers".into());
    }
    private_write(&state.directory.join("endpoint"), endpoint.as_bytes())?;
    client.endpoint = endpoint;
    Ok(())
}

#[tauri::command]
pub async fn stream_events(
    state: tauri::State<'_, State>,
    channel: tauri::ipc::Channel<Value>,
) -> Result<(), String> {
    let mut response = state
        .request(
            "v1/stream",
            json!({ "type": "subscribe", "payload": {} }),
            true,
        )
        .await?;
    if !response.status().is_success() {
        return Err(format!("Live stream rejected ({})", response.status()));
    }
    let mut decoder = crate::sse::Decoder::default();
    while let Some(bytes) = response.chunk().await.map_err(|e| e.to_string())? {
        for frame in decoder.push(&bytes)? {
            channel.send(frame).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn query(
    state: tauri::State<'_, State>,
    kind: String,
    payload: Value,
) -> Result<Value, String> {
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
        return Err(value["message"]
            .as_str()
            .unwrap_or("Server query failed")
            .into());
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
    let command = {
        let mut client = state.client.lock().map_err(|_| "Connection lock failed")?;
        state.identity(&mut client)?;
        if client.pending.is_some() {
            return Err(
                "A previous command has an unknown outcome. Retry that command first.".into(),
            );
        }
        let command = json!({ "protocolVersion": 1, "commandId": Uuid::new_v4(), "idempotencyKey": Uuid::new_v4(), "aggregateId": id, "expectedRevision": revision, "type": kind, "payload": payload });
        client.pending = Some(command.clone());
        if let Err(error) = state.persist_pending(&client) {
            client.pending = None;
            return Err(format!(
                "Command was not sent: could not save its encrypted retry envelope. {error}"
            ));
        }
        command
    };
    state.submit(command).await
}

#[tauri::command]
pub async fn retry_command(state: tauri::State<'_, State>) -> Result<Value, String> {
    let command = {
        let mut client = state.client.lock().map_err(|_| "Connection lock failed")?;
        state.identity(&mut client)?;
        client
            .pending
            .clone()
            .ok_or("There is no pending command")?
    };
    state.submit(command).await
}

#[tauri::command]
pub async fn pair(state: tauri::State<'_, State>, token: String) -> Result<(), String> {
    let body = {
        let mut client = state.client.lock().map_err(|_| "Connection lock failed")?;
        state.identity(&mut client)?;
        let identity = client
            .identity
            .as_ref()
            .ok_or("Device identity unavailable")?;
        json!({ "deviceId": identity.id, "name": "Outpost Desktop", "publicKey": STANDARD.encode(identity.key.verifying_key().to_bytes()), "token": token.trim() })
    };
    // Bootstrap has a strict schema and deliberately does not include issuedAt.
    let endpoint = state
        .client
        .lock()
        .map_err(|_| "Connection lock failed")?
        .endpoint
        .clone();
    let response = state
        .http
        .post(format!("{endpoint}/v1/pair"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        return Err(body["message"].as_str().unwrap_or("Pairing failed").into());
    }
    Ok(())
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
}
