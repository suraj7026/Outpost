use super::*;
use std::io::{Read, Write};
const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECORD: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
pub(crate) fn identify(state: &State) {
    state.client.lock().unwrap().identity = Some(Identity {
        id: "11111111-1111-4111-8111-111111111111".into(),
        key: SigningKey::from_bytes(&[7; 32]),
    });
}
fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!("outpost-environments-test-{}", Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    path
}
pub(crate) fn descriptor(id: &str) -> Value {
    json!({"descriptorVersion":1,"environmentId":id,"label":"Fixture","protocolVersion":2,"recordProtocolVersion":1,
        "supportedProtocolVersions":[1,2],"legacyUnboundRequests":true,"runtime":{"release":null,"platform":"test","architecture":"test"},
        "capabilities":{"environmentBoundRequests":true,"snapshots":true,"eventStream":true,"artifacts":true,"deviceEnrollment":true,"historyReplication":false,"taskHandoff":false},
        "services":{"worker":{"configured":false,"readiness":"not_configured"},"hostAdministration":{"configured":true,"readiness":"unknown"}}})
}
struct Reply {
    protocol: u8,
    status: u16,
    id: String,
    bytes: Vec<u8>,
    delay: u64,
}
fn reply(id: &str, status: u16, value: Value) -> Reply {
    Reply {
        protocol: 2,
        status,
        id: id.into(),
        bytes: value.to_string().into_bytes(),
        delay: 0,
    }
}
// Wire-level local HTTP fixture, not a coordinator. It verifies actual Ed25519 signed bytes.
fn server(replies: Vec<Reply>) -> (String, std::thread::JoinHandle<Vec<(String, Value)>>) {
    server_observed(replies, |_, _| {})
}
fn server_observed(
    replies: Vec<Reply>,
    observe: impl Fn(&str, &Value) + Send + 'static,
) -> (String, std::thread::JoinHandle<Vec<(String, Value)>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline, "fixture timed out");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            let (end, length) = loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let length = header
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .map(|v| v.parse::<usize>().unwrap())
                        .unwrap_or(0);
                    break (end + 4, length);
                }
            };
            while bytes.len() < end + length {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
            let body = &bytes[end..end + length];
            let value = if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice::<Value>(body).unwrap()
            };
            if !header.starts_with("GET ") && !header.starts_with("POST /v2/pair ") {
                let sig = header
                    .lines()
                    .find_map(|v| v.strip_prefix("x-outpost-signature: "))
                    .expect("signature");
                let sig =
                    ed25519_dalek::Signature::from_slice(&STANDARD.decode(sig).unwrap()).unwrap();
                SigningKey::from_bytes(&[7; 32])
                    .verifying_key()
                    .verify_strict(body, &sig)
                    .unwrap();
                assert_eq!(
                    value["protocolVersion"],
                    if header.contains("/v1/") { 1 } else { 2 }
                );
                assert!(value["issuedAt"].as_u64().is_some());
            }
            observe(&header, &value);
            let streaming = header.starts_with("POST /v2/stream ");
            requests.push((header, value));
            std::thread::sleep(Duration::from_millis(reply.delay));
            let mut response = format!("HTTP/1.1 {} Fixture\r\nx-outpost-environment-id: {}\r\nx-outpost-protocol-version: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.status, reply.id, reply.protocol, reply.bytes.len()).into_bytes();
            response.extend_from_slice(&reply.bytes);
            if let Err(error) = socket.write_all(&response) {
                // A deliberately cancelled stream may close before its headers arrive.
                assert!(
                    streaming && matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset),
                    "Unexpected fixture response failure: {error}"
                );
            }
        }
        requests
    });
    (endpoint, handle)
}
fn connection(root: &std::path::Path, id: &str, endpoint: &str) -> State {
    let state = Registry::connection(root, id, endpoint).unwrap();
    identify(&state);
    state
}
#[test]
fn browser_input_is_environment_bound_without_pending_files_or_response_leaks() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let (url, requests) = server(vec![reply(A, 200, json!({"applied":true})), reply(B, 200, json!({"message":"synthetic-private-browser-text"}))]);
        let state = connection(&dir, A, &url);
        let payload = json!({"type":"input","taskId":RECORD,"epoch":RECORD,"leaseId":RECORD,"frameId":RECORD,
            "input":{"action":"text","text":"synthetic-private-browser-text"}});
        assert_eq!(state.browser_request(payload.clone()).await.unwrap()["applied"], true);
        let error = state.browser_request(payload).await.unwrap_err();
        assert!(!error.contains("synthetic-private-browser-text"));
        let captured = requests.join().unwrap();
        for (header, body) in &captured {
            assert!(header.starts_with("POST /v2/browser HTTP/1.1"));
            assert_eq!(body["environmentId"], A);
        }
        assert_ne!(captured[0].1["payload"]["requestId"], captured[1].1["payload"]["requestId"]);
        assert!(!state.directory.join("pending.enc").exists());
        fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn native_creation_receipt_registers_independently_without_retiring_legacy_or_pairing_again() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut registry = Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        // Even an unrelated unresolved legacy effect stays on its original connection.
        fs::write(dir.join("pending.enc"), b"preserve-original-recovery").unwrap();
        let (endpoint, requests) = server(vec![reply(A, 200, descriptor(A)), reply(A, 200, descriptor(A))]);
        let result = registry.register_created(A.into(), endpoint, "New independent host".into()).await.unwrap();
        assert!(!result.legacy_mutations_retired);
        assert!(result.environments.contains_key(A));
        assert_eq!(fs::read(dir.join("pending.enc")).unwrap(), b"preserve-original-recovery");
        assert!(requests.join().unwrap().iter().all(|(header, _)| !header.contains("/pair")));
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn registry_verified_adoption_restart_selection_and_corruption() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut registry =
            Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        let (url, requests) = server(vec![
            reply(A, 200, descriptor(A)),
            reply(A, 200, descriptor(A)),
        ]);
        registry
            .register(A.into(), url.clone(), "Home".into(), None, true)
            .await
            .unwrap();
        registry
            .update(|m| {
                m.selected_environment_id = Some(A.into());
                Ok(())
            })
            .unwrap();
        let requests = requests.join().unwrap();
        assert!(requests[1].0.starts_with("POST /v2/query "));
        assert_eq!(requests[1].1["environmentId"], A);
        let reopened = Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        assert_eq!(
            reopened.get(A).unwrap().client.lock().unwrap().endpoint,
            url
        );
        assert_eq!(
            reopened
                .inner
                .lock()
                .unwrap()
                .metadata
                .selected_environment_id
                .as_deref(),
            Some(A)
        );
        let path = dir.join("environments/registry.json");
        let saved = fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("publicKey") && !saved.contains("token"));
        fs::write(&path, b"{}").unwrap();
        assert!(Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).is_err());
        fs::remove_file(path).unwrap();
        assert!(Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).is_err());
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn route_mismatch_and_pairing_ambiguity_never_save_or_reenroll() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut registry =
            Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        let (url, requests) = server(vec![reply(B, 200, descriptor(B))]);
        assert!(registry
            .register(A.into(), url, "Home".into(), None, true)
            .await
            .is_err());
        requests.join().unwrap();
        assert!(registry.get(A).is_err());
        let (url, requests) = server(vec![
            reply(A, 200, descriptor(A)),
            reply(A, 200, json!({})),
            reply(B, 200, descriptor(B)),
        ]);
        assert!(registry
            .register(
                A.into(),
                url,
                "Home".into(),
                Some("ephemeral-token".into()),
                true
            )
            .await
            .is_err());
        let requests = requests.join().unwrap();
        assert!(requests[1].0.starts_with("POST /v2/pair "));
        assert_eq!(requests[1].1["environmentId"], A);
        assert!(requests[1].1.get("issuedAt").is_none());
        assert!(registry.get(A).is_err());
        assert!(
            !fs::read_to_string(dir.join("environments").join(A).join("pairing-attempt"))
                .unwrap()
                .contains("ephemeral-token")
        );
        let (url, requests) = server(vec![reply(A, 200, descriptor(A))]);
        assert!(registry
            .register(
                A.into(),
                url,
                "Home".into(),
                Some("ephemeral-token".into()),
                true
            )
            .await
            .unwrap_err()
            .contains("may already have succeeded"));
        requests.join().unwrap();
        let (url, requests) = server(vec![
            reply(A, 200, descriptor(A)),
            reply(A, 200, descriptor(A)),
        ]);
        registry
            .register(A.into(), url, "Home".into(), None, true)
            .await
            .unwrap();
        requests.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn bound_pending_survives_restart_wrong_response_and_safe_route_change() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let (url, requests) = server(vec![reply(B, 400, json!({"message":"wrong target"}))]);
        let state = connection(&dir, A, &url);
        assert!(state
            .send_command("task.create".into(), RECORD.into(), 7, json!({}))
            .await
            .is_err());
        let first = requests.join().unwrap().remove(0).1;
        assert_eq!(first["environmentId"], A);
        assert!(state.directory.join("pending.enc").exists());
        let (url, requests) = server(vec![reply(A, 200, json!({"id":RECORD}))]);
        let restarted = connection(&dir, A, &url);
        assert_eq!(restarted.retry_command().await.unwrap()["id"], RECORD);
        let retry = requests.join().unwrap().remove(0).1;
        for key in [
            "environmentId",
            "commandId",
            "idempotencyKey",
            "expectedRevision",
            "aggregateId",
        ] {
            assert_eq!(first[key], retry[key]);
        }
        assert!(!restarted.directory.join("pending.enc").exists());
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn corrupt_unreadable_and_cross_environment_pending_fail_closed() {
    let dir = directory();
    let a = connection(&dir, A, "http://127.0.0.1:1");
    let b = connection(&dir, B, "http://127.0.0.1:1");
    let command = json!({"protocolVersion":2,"environmentId":A,"commandId":Uuid::new_v4(),"idempotencyKey":Uuid::new_v4(),"type":"task.create","aggregateId":RECORD,"expectedRevision":0,"payload":{}});
    {
        let mut c = a.client.lock().unwrap();
        c.pending = Some(command);
        a.persist_pending(&c).unwrap();
    }
    fs::copy(
        a.directory.join("pending.enc"),
        b.directory.join("pending.enc"),
    )
    .unwrap();
    assert!(b
        .load_pending(&mut b.client.lock().unwrap())
        .unwrap_err()
        .contains("binding"));
    fs::write(a.directory.join("pending.enc"), b"corrupt").unwrap();
    assert!(a.load_pending(&mut a.client.lock().unwrap()).is_err());
    fs::remove_file(a.directory.join("pending.enc")).unwrap();
    fs::create_dir(a.directory.join("pending.enc")).unwrap();
    assert!(a
        .load_pending(&mut a.client.lock().unwrap())
        .unwrap_err()
        .contains("Cannot read"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn concurrent_mutations_are_serialized_without_blocking_other_environment() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut slow = reply(A, 500, json!({"message":"uncertain"}));
        slow.delay = 150;
        let (url, requests) = server(vec![slow]);
        let a = connection(&dir, A, &url);
        let (url, other) = server(vec![
            reply(B, 200, json!({"records":[{"id":RECORD}]})),
            reply(B, 200, json!({"id":RECORD})),
        ]);
        let b = connection(&dir, B, &url);
        let first = a.send_command("task.create".into(), RECORD.into(), 0, json!({}));
        let parallel = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(a.retry_command().await.unwrap_err().contains("in progress"));
            assert!(a
                .send_command("task.create".into(), RECORD.into(), 0, json!({}))
                .await
                .unwrap_err()
                .contains("in progress"));
            assert_eq!(
                query_value(&b, "snapshot".into(), json!({})).await.unwrap()["records"][0]["id"],
                RECORD
            );
            assert_eq!(
                b.send_command("task.create".into(), RECORD.into(), 0, json!({}))
                    .await
                    .unwrap()["id"],
                RECORD
            );
        };
        let (result, ()) = tokio::join!(first, parallel);
        assert!(result.is_err());
        requests.join().unwrap();
        other.join().unwrap();
        assert!(a.directory.join("pending.enc").exists());
        assert!(!b.directory.join("pending.enc").exists());
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn offline_environment_does_not_block_provider_and_colliding_artifacts() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let a = connection(&dir, A, "http://127.0.0.1:1");
        assert!(a
            .send_command("task.create".into(), RECORD.into(), 0, json!({}))
            .await
            .is_err());
        let content = b"artifact B";
        let (url, requests) = server(vec![
            reply(B, 400, json!({"message":"synthetic-secret"})),
            Reply {
                protocol: 2,
                status: 200,
                id: B.into(),
                bytes: content.to_vec(),
                delay: 0,
            },
        ]);
        let b = connection(&dir, B, &url);
        assert!(!b
            .agent_request(json!({"type":"login.answer","value":"synthetic-secret"}))
            .await
            .unwrap_err()
            .contains("synthetic-secret"));
        assert_eq!(
            artifact_bytes(&b, RECORD, &format!("{:x}", Sha256::digest(content)))
                .await
                .unwrap(),
            content
        );
        let captured = requests.join().unwrap();
        assert!(captured[0].0.starts_with("POST /v2/agent "));
        assert!(captured[1].0.starts_with("POST /v2/artifact "));
        assert_eq!(captured[1].1["environmentId"], B);
        assert_eq!(fs::read_dir(&b.directory).unwrap().count(), 0);
        assert_ne!(
            dir.join("Outpost").join(A).join(RECORD),
            dir.join("Outpost").join(B).join(RECORD)
        );
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn stream_disconnect_cancels_only_its_own_inflight_connection() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let observed = Arc::new(tokio::sync::Notify::new());
        let request_observed = observed.clone();
        let (release, held_response) = std::sync::mpsc::channel();
        let (url, one) = server_observed(vec![reply(A, 200, json!({}))], move |_, _| {
            request_observed.notify_one();
            held_response.recv_timeout(Duration::from_secs(10)).unwrap();
        });
        let a = connection(&dir, A, &url);
        let (url, two) = server(vec![Reply {
            protocol: 2,
            status: 200,
            id: B.into(),
            bytes: b"data: {\"type\":\"fixture\"}\n\n".to_vec(),
            delay: 80,
        }]);
        let b = connection(&dir, B, &url);
        let received = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = received.clone();
        let first = a.bound_stream(tauri::ipc::Channel::new(|_| {
            panic!("cancelled stream must not emit")
        }));
        let second = b.bound_stream(tauri::ipc::Channel::new(move |_| {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }));
        let stop = async {
            observed.notified().await;
            a.cancel_stream().unwrap();
        };
        let (a_result, b_result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(first, second, stop)
        }).await.expect("Cancellation must settle A before the held response is released");
        a_result.unwrap();
        b_result.unwrap();
        assert_eq!(received.load(std::sync::atomic::Ordering::SeqCst), 1);
        release.send(()).unwrap();
        let requests = one.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].1["environmentId"], A);
        two.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn legacy_pending_is_preserved_and_blocks_automatic_adoption_not_other_environments() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        fs::write(dir.join("endpoint"), "http://127.0.0.1:1").unwrap();
        fs::write(dir.join("pending.enc"), b"legacy-ambiguous").unwrap();
        let mut registry =
            Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        assert!(registry
            .register(
                A.into(),
                "http://127.0.0.1:1".into(),
                "Old".into(),
                None,
                true
            )
            .await
            .unwrap_err()
            .contains("legacy"));
        let (url, requests) = server(vec![
            reply(B, 200, descriptor(B)),
            reply(B, 200, json!({})),
            reply(B, 200, descriptor(B)),
        ]);
        registry
            .register(B.into(), url, "New".into(), Some("new-token".into()), false)
            .await
            .unwrap();
        requests.join().unwrap();
        assert_eq!(
            fs::read(dir.join("pending.enc")).unwrap(),
            b"legacy-ambiguous"
        );
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn registry_and_descriptor_reject_unsafe_identifiers_urls_and_unknown_metadata() {
    assert!(validate_id("../../outside").is_err());
    assert!(validate_id(&A.to_uppercase()).is_err());
    for url in [
        "http://192.0.2.1",
        "https://user:secret@example.test",
        "https://example.test?token=secret",
    ] {
        assert!(validate_endpoint(url).is_err());
    }
    let mut value = descriptor(A);
    value["token"] = json!("never-save");
    assert!(validate_descriptor(&value, Some(A)).is_err());
    let mut value = descriptor(A);
    value["protocolVersion"] = json!(1);
    assert!(validate_descriptor(&value, Some(A)).is_err());
    let dir = directory();
    let registry = Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    assert!(registry
        .update(|m| {
            m.selected_environment_id = Some(A.into());
            Ok(())
        })
        .is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn adoption_requires_explicit_retirement_and_gates_legacy_mutations() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let legacy = State::new(dir.clone()).unwrap();
        identify(&legacy);
        let mut registry = Registry::new(dir.clone(), legacy.mutation_gate()).unwrap();
        registry.fixture_identity = true;
        assert!(registry
            .register(
                A.into(),
                "http://127.0.0.1:1".into(),
                "Adopt".into(),
                None,
                false
            )
            .await
            .unwrap_err()
            .starts_with("needs_legacy_retirement"));
        legacy.allow_mutation().unwrap();
        assert!(registry.get(A).is_err());
        let held = legacy.mutation.lock().await;
        assert!(registry
            .register(
                A.into(),
                "http://127.0.0.1:1".into(),
                "Adopt".into(),
                None,
                true
            )
            .await
            .unwrap_err()
            .contains("in progress"));
        drop(held);
        fs::write(dir.join("pending.enc"), b"unbound").unwrap();
        assert!(registry
            .register(
                A.into(),
                "http://127.0.0.1:2".into(),
                "Alternate route".into(),
                None,
                true
            )
            .await
            .unwrap_err()
            .contains("legacy pending"));
        fs::remove_file(dir.join("pending.enc")).unwrap();
        let (url, requests) = server(vec![
            reply(A, 200, descriptor(A)),
            reply(A, 200, descriptor(A)),
        ]);
        registry
            .register(A.into(), url, "Adopt".into(), None, true)
            .await
            .unwrap();
        requests.join().unwrap();
        assert!(legacy
            .send_command("task.create".into(), RECORD.into(), 0, json!({}))
            .await
            .unwrap_err()
            .contains("read-only"));
        assert!(legacy
            .agent_request(json!({"type":"login.answer","value":"secret"}))
            .await
            .unwrap_err()
            .contains("read-only"));
        assert!(legacy
            .pair("token".into())
            .await
            .unwrap_err()
            .contains("read-only"));
        assert!(!dir.join("pending.enc").exists());
        let restarted = State::new(dir.clone()).unwrap();
        assert!(restarted.allow_mutation().is_err());
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn removal_blocks_pending_preserves_recovery_and_rejects_stale_handles() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut registry =
            Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        let (url, requests) = server(vec![
            reply(A, 200, descriptor(A)),
            reply(A, 200, descriptor(A)),
            reply(A, 500, json!({"message":"uncertain"})),
        ]);
        registry
            .register(A.into(), url, "Saved".into(), None, true)
            .await
            .unwrap();
        let state = registry.get(A).unwrap();
        state
            .send_command("task.create".into(), RECORD.into(), 0, json!({}))
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(registry
            .remove(A.into())
            .await
            .unwrap_err()
            .contains("pending"));
        let (url, requests) = server(vec![reply(A, 200, json!({"id":RECORD}))]);
        state.client.lock().unwrap().endpoint = url;
        state.retry_command().await.unwrap();
        requests.join().unwrap();
        registry.remove(A.into()).await.unwrap();
        assert!(registry.get(A).is_err());
        assert!(state.directory.exists());
        assert!(state
            .send_command("task.create".into(), RECORD.into(), 0, json!({}))
            .await
            .unwrap_err()
            .contains("removed"));
        assert!(state
            .bound_stream(tauri::ipc::Channel::new(|_| Ok(())))
            .await
            .is_err());
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn saved_artifact_paths_are_validated_and_isolated_for_colliding_ids() {
    let dir = directory();
    let a = artifact_directory(&dir, A, RECORD).unwrap();
    let b = artifact_directory(&dir, B, RECORD).unwrap();
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    private_write(&a.join("result.txt"), b"A").unwrap();
    private_write(&b.join("result.txt"), b"B").unwrap();
    assert_eq!(fs::read(a.join("result.txt")).unwrap(), b"A");
    assert_eq!(fs::read(b.join("result.txt")).unwrap(), b"B");
    assert!(artifact_directory(&dir, "../../", RECORD).is_err());
    assert!(artifact_directory(&dir, A, "../../").is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn deleting_the_legacy_connection_persists_and_preserves_pending_recovery() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let legacy = State::new(dir.clone()).unwrap();
        identify(&legacy);
        let (url, requests) = server(vec![reply(A, 500, json!({"message":"uncertain"}))]);
        legacy.set_endpoint(url.clone()).await.unwrap();
        assert!(legacy.send_command("task.create".into(), RECORD.into(), 0, json!({})).await.is_err());
        requests.join().unwrap();
        assert!(legacy.clear_legacy_endpoint().await.unwrap_err().contains("pending"));
        assert_eq!(super::super::legacy_endpoint(&dir).unwrap(), url);
        assert!(dir.join("pending.enc").exists());

        // Simulate a settled pending command before the owner deletes the route.
        fs::remove_file(dir.join("pending.enc")).unwrap();
        legacy.clear_legacy_endpoint().await.unwrap();
        let reopened = State::new(dir.clone()).unwrap();
        assert!(reopened.client.lock().unwrap().endpoint.is_empty());
        assert!(reopened.send_command("task.create".into(), RECORD.into(), 0, json!({})).await
            .unwrap_err().contains("No server connection"));
        assert!(!dir.join("pending.enc").exists());
        fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn registered_environments_freeze_legacy_endpoint_but_allow_normalized_noop() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let legacy = State::new(dir.clone()).unwrap();
        identify(&legacy);
        let mut registry = Registry::new(dir.clone(), legacy.mutation_gate()).unwrap();
        registry.fixture_identity = true;
        let (url, requests) = server(vec![
            reply(B, 200, descriptor(B)),
            reply(B, 200, json!({})),
            reply(B, 200, descriptor(B)),
        ]);
        registry
            .register(
                B.into(),
                url.clone(),
                "New".into(),
                Some("new".into()),
                false,
            )
            .await
            .unwrap();
        requests.join().unwrap();
        legacy
            .set_endpoint("HTTP://127.0.0.1:4318/".into())
            .await
            .unwrap();
        legacy.allow_mutation().unwrap();
        for endpoint in [url, "http://localhost:9999".into()] {
            assert!(legacy
                .set_endpoint(endpoint)
                .await
                .unwrap_err()
                .contains("endpoint changes are disabled"));
        }
        assert_eq!(
            legacy.client.lock().unwrap().endpoint,
            "http://127.0.0.1:4318"
        );
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn bootstrap_rechecks_concurrent_legacy_endpoint_and_pending_before_committing() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let legacy = State::new(dir.clone()).unwrap();
        identify(&legacy);
        let mut registry = Registry::new(dir.clone(), legacy.mutation_gate()).unwrap();
        registry.fixture_identity = true;
        let mut delayed = reply(B, 200, descriptor(B));
        delayed.delay = 120;
        let (url, requests) = server(vec![
            reply(B, 200, descriptor(B)),
            reply(B, 200, json!({})),
            delayed,
        ]);
        let registration = registry.register(
            B.into(),
            url.clone(),
            "New".into(),
            Some("new".into()),
            false,
        );
        let legacy_change = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            legacy.set_endpoint(url).await.unwrap();
            let _gate = legacy.mutation.lock().await;
            let mut client = legacy.client.lock().unwrap();
            client.pending = Some(
                json!({"protocolVersion":1,"commandId":Uuid::new_v4(),"idempotencyKey":Uuid::new_v4(),"type":"task.create","aggregateId":RECORD,"expectedRevision":0,"payload":{}}),
            );
            legacy.persist_pending(&client).unwrap();
        };
        let (result, ()) = tokio::join!(registration, legacy_change);
        assert!(result
            .unwrap_err()
            .contains("Paired, registration not completed"));
        requests.join().unwrap();
        assert!(registry.get(B).is_err());
        assert!(dir.join("pending.enc").exists());
        legacy.allow_mutation().unwrap();
        fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn protocol_header_mismatch_preserves_unknown_and_enrollment_uploads_are_bound() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut wrong = reply(A, 200, json!({"id":RECORD}));
        wrong.protocol = 1;
        let (url, requests) = server(vec![wrong]);
        let a = connection(&dir, A, &url);
        assert!(a
            .send_command("task.create".into(), RECORD.into(), 0, json!({}))
            .await
            .unwrap_err()
            .contains("protocol mismatch"));
        requests.join().unwrap();
        assert!(a.directory.join("pending.enc").exists());
        let (url, requests) = server(vec![
            reply(B, 200, json!({"id":RECORD})),
            reply(B, 200, json!({"id":RECORD})),
            reply(B, 200, json!({"id":RECORD})),
            reply(B, 200, json!({"id":RECORD})),
        ]);
        let b = connection(&dir, B, &url);
        b.enroll_device(
            RECORD.into(),
            "Other device".into(),
            STANDARD.encode([9; 32]),
        )
        .await
        .unwrap();
        for kind in ["artifact.begin", "artifact.chunk", "artifact.complete"] {
            b.send_command(kind.into(), RECORD.into(), 0, json!({}))
                .await
                .unwrap();
        }
        let captured = requests.join().unwrap();
        assert!(captured[0].0.starts_with("POST /v2/pair-device "));
        assert_eq!(captured[0].1["payload"]["deviceId"], RECORD);
        for (_, body) in captured {
            assert_eq!(body["environmentId"], B);
        }
        fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn stale_success_cannot_clear_a_newer_durable_command() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let (url, requests) = server(vec![reply(A, 200, json!({"id":RECORD}))]);
        let state = connection(&dir, A, &url);
        let old = json!({"protocolVersion":2,"environmentId":A,"commandId":Uuid::new_v4(),"idempotencyKey":Uuid::new_v4(),"type":"task.create","aggregateId":RECORD,"expectedRevision":0,"payload":{}});
        let mut newer = old.clone();
        newer["commandId"] = json!(Uuid::new_v4());
        newer["idempotencyKey"] = json!(Uuid::new_v4());
        {
            let mut client = state.client.lock().unwrap();
            client.pending = Some(newer.clone());
            state.persist_pending(&client).unwrap();
        }
        assert!(state
            .submit(old)
            .await
            .unwrap_err()
            .contains("cannot clear"));
        requests.join().unwrap();
        let mut client = state.client.lock().unwrap();
        state.load_pending(&mut client).unwrap();
        assert_eq!(client.pending, Some(newer));
        drop(client);
        fs::remove_dir_all(dir).unwrap();
    });
}

#[path = "environment_review_tests.rs"]
mod review;
