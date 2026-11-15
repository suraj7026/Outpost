use super::*;

fn legacy_envelope(dir: &std::path::Path, endpoint: &str) -> Value {
    fs::write(dir.join("endpoint"), endpoint).unwrap();
    let state = State::new(dir.to_owned()).unwrap();
    identify(&state);
    let command = json!({"protocolVersion":1,"commandId":Uuid::new_v4(),"idempotencyKey":Uuid::new_v4(),"type":"task.create","aggregateId":RECORD,"expectedRevision":9,"payload":{"goal":"preserved legacy payload"}});
    // Pre-upgrade format/spelling, deliberately not produced by the new persistence helper.
    let clear = serde_json::to_vec(&json!({"endpoint":endpoint,"command":command})).unwrap();
    let client = state.client.lock().unwrap();
    let nonce = [6; 12];
    let encrypted = State::cipher(client.identity.as_ref().unwrap())
        .encrypt(Nonce::from_slice(&nonce), clear.as_slice())
        .unwrap();
    fs::write(
        dir.join("pending.enc"),
        [nonce.to_vec(), encrypted].concat(),
    )
    .unwrap();
    command
}
#[test]
fn pre_upgrade_legacy_url_spelling_retries_original_command_without_rebinding() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let original = legacy_envelope(&dir, "HTTP://LOCALHOST:80");
        let bytes = fs::read(dir.join("pending.enc")).unwrap();
        let mut state = State::new(dir.clone()).unwrap();
        identify(&state);
        assert_eq!(state.client.lock().unwrap().endpoint, "http://localhost");
        // A loopback HTTP proxy exercises the actual legacy wire retry without binding privileged port 80.
        let (proxy, requests) = server(vec![
            reply(A, 500, json!({"message":"uncertain"})),
            reply(A, 200, json!({"id":RECORD})),
        ]);
        state.http = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(proxy).unwrap())
            .build()
            .unwrap();
        assert!(state.retry_command().await.is_err());
        assert_eq!(fs::read(dir.join("pending.enc")).unwrap(), bytes);
        state.retry_command().await.unwrap();
        for (header, body) in requests.join().unwrap() {
            assert!(header.starts_with("POST http://localhost/v1/commands "));
            assert!(body.get("environmentId").is_none());
            for (key, value) in original.as_object().unwrap() {
                assert_eq!(&body[key], value);
            }
        }
        assert!(!dir.join("pending.enc").exists());
        legacy_envelope(&dir, "HTTPS://EXAMPLE.TEST:443");
        let same = State::new(dir.clone()).unwrap();
        identify(&same);
        same.load_pending(&mut same.client.lock().unwrap()).unwrap();
        for endpoint in [
            "https://other.test",
            "https://example.test:444",
            "https://example.test/other",
            "http://example.test",
        ] {
            let mut client = same.client.lock().unwrap();
            client.endpoint = endpoint.into();
            assert!(same.load_pending(&mut client).is_err());
        }
        assert!(dir.join("pending.enc").exists());
        fs::remove_dir_all(dir).unwrap();
    });
}

struct SyncHook;
impl Drop for SyncHook {
    fn drop(&mut self) {
        DIRECTORY_SYNC_HOOK.with(|h| *h.borrow_mut() = None);
    }
}
fn hook(f: impl FnMut(&std::path::Path) -> Result<(), String> + 'static) -> SyncHook {
    DIRECTORY_SYNC_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
    SyncHook
}
#[test]
fn recovery_directory_barriers_precede_pairing_and_failures_stop_dispatch() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let trace = Arc::new(Mutex::new(Vec::new()));
        let log = trace.clone();
        let _hook = hook(move |path| {
            log.lock().unwrap().push(path.to_owned());
            Ok(())
        });
        let mut registry =
            Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        let root = dir.join("environments");
        let child = root.join(A);
        let expected = vec![dir.clone(), root.clone(), root.clone(), child.clone()];
        let seen = trace.clone();
        let (url, requests) = server_observed(
            vec![
                reply(A, 200, descriptor(A)),
                reply(A, 200, json!({})),
                reply(A, 200, descriptor(A)),
            ],
            move |header, _| {
                if header.starts_with("POST /v2/pair ") {
                    assert_eq!(*seen.lock().unwrap(), expected);
                }
            },
        );
        registry
            .register(A.into(), url, "New".into(), Some("bootstrap".into()), false)
            .await
            .unwrap();
        requests.join().unwrap();
        drop(_hook);
        fs::remove_dir_all(dir).unwrap();

        // Root mkdir succeeded but its parent barrier failed: initialized directory is never silently replaced.
        let dir = directory();
        let fail = dir.clone();
        let guard = hook(move |path| {
            if path == fail {
                Err("injected parent sync failure".into())
            } else {
                Ok(())
            }
        });
        assert!(Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).is_err());
        drop(guard);
        assert!(Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).is_err());
        fs::remove_dir_all(dir).unwrap();

        for fail_marker in [false, true] {
            let dir = directory();
            let mut registry =
                Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
            registry.fixture_identity = true;
            let fail = if fail_marker {
                dir.join("environments").join(A)
            } else {
                dir.join("environments")
            };
            let guard = hook(move |path| {
                if path == fail {
                    Err("injected sync failure".into())
                } else {
                    Ok(())
                }
            });
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let discovery = if fail_marker {
                let clone = listener.try_clone().unwrap();
                Some(std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + Duration::from_secs(5);
                    let mut socket = loop {
                        match clone.accept() {
                            Ok((s, _)) => break s,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(std::time::Instant::now() < deadline);
                                std::thread::yield_now();
                            }
                            Err(e) => panic!("{e}"),
                        }
                    };
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut byte = [0; 1];
                    while !bytes.ends_with(b"\r\n\r\n") {
                        socket.read_exact(&mut byte).unwrap();
                        bytes.push(byte[0]);
                    }
                    assert!(bytes.starts_with(b"GET /v2/environment "));
                    let body = descriptor(A).to_string();
                    write!(socket,"HTTP/1.1 200 OK\r\nx-outpost-environment-id: {A}\r\nx-outpost-protocol-version: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }))
            } else {
                None
            };
            assert!(registry
                .register(A.into(), url, "New".into(), Some("bootstrap".into()), false)
                .await
                .unwrap_err()
                .contains("injected sync failure"));
            if let Some(h) = discovery {
                h.join().unwrap();
            }
            // The listener stays open: any attempted pairing connection would be observable here.
            assert!(listener.accept().is_err());
            assert!(registry.get(A).is_err());
            drop(guard);
            if fail_marker {
                assert!(dir
                    .join("environments")
                    .join(A)
                    .join("pairing-attempt")
                    .exists());
                let (url, requests) = server(vec![reply(A, 200, descriptor(A))]);
                assert!(registry
                    .register(A.into(), url, "New".into(), Some("bootstrap".into()), false)
                    .await
                    .unwrap_err()
                    .contains("may already have succeeded"));
                requests.join().unwrap();
            }
            fs::remove_dir_all(dir).unwrap();
        }
    });
}

#[derive(Default)]
struct MemoryIdentityStore {
    bytes: Mutex<Option<Vec<u8>>>,
    writes: std::sync::atomic::AtomicUsize,
    fail_read: bool,
}
impl IdentityStore for MemoryIdentityStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        if self.fail_read {
            Err("injected store read failure".into())
        } else {
            Ok(self.bytes.lock().unwrap().clone())
        }
    }
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        self.writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.bytes.lock().unwrap() = Some(bytes.to_vec());
        Ok(())
    }
}
#[test]
fn concurrent_first_use_creates_one_identity_and_read_errors_never_replace_it() {
    let dir = directory();
    let store = Arc::new(MemoryIdentityStore::default());
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let mut state = State::new(dir.clone()).unwrap();
            state.identity_store = Some(store.clone());
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let mut c = state.client.lock().unwrap();
                state.identity(&mut c).unwrap();
                let identity = c.identity.as_ref().unwrap();
                (identity.id.clone(), identity.key.to_bytes())
            })
        })
        .collect();
    barrier.wait();
    let mut identities = workers.into_iter().map(|h| h.join().unwrap());
    assert_eq!(identities.next(), identities.next());
    assert_eq!(store.writes.load(std::sync::atomic::Ordering::SeqCst), 1);
    for invalid in [false, true] {
        let bad = Arc::new(MemoryIdentityStore {
            fail_read: !invalid,
            bytes: Mutex::new(Some(b"corrupt existing identity".to_vec())),
            ..Default::default()
        });
        let mut state = State::new(dir.clone()).unwrap();
        state.identity_store = Some(bad.clone());
        assert!(state.identity(&mut state.client.lock().unwrap()).is_err());
        assert_eq!(bad.writes.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn verified_registry_route_replacement_preserves_pending_through_restart() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut registry =
            Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        let (url, first) = server(vec![
            reply(A, 200, descriptor(A)),
            reply(A, 200, descriptor(A)),
            reply(A, 500, json!({"message":"uncertain"})),
        ]);
        registry
            .register(A.into(), url, "Saved".into(), None, true)
            .await
            .unwrap();
        registry
            .get(A)
            .unwrap()
            .send_command(
                "task.create".into(),
                RECORD.into(),
                11,
                json!({"goal":"same payload"}),
            )
            .await
            .unwrap_err();
        let original = first.join().unwrap().pop().unwrap().1;
        let (url, second) = server(vec![
            reply(A, 200, descriptor(A)),
            reply(A, 200, descriptor(A)),
            reply(A, 200, json!({"id":RECORD})),
        ]);
        registry
            .register(A.into(), url.clone(), "Alternate".into(), None, false)
            .await
            .unwrap();
        drop(registry);
        let restarted = Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        let state = restarted.get(A).unwrap();
        identify(&state);
        assert_eq!(state.client.lock().unwrap().endpoint, url);
        state.retry_command().await.unwrap();
        let retry = second.join().unwrap().pop().unwrap().1;
        for key in [
            "protocolVersion",
            "environmentId",
            "commandId",
            "idempotencyKey",
            "aggregateId",
            "expectedRevision",
            "type",
            "payload",
        ] {
            assert_eq!(original[key], retry[key]);
        }
        assert!(!state.directory.join("pending.enc").exists());
        fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn native_ipc_decodes_camel_case_optional_flags_metadata_and_stream_channels() {
    let dir = directory();
    let mut stream = reply(A, 200, Value::Null);
    stream.bytes = b"data: {\"type\":\"native-ipc-frame\"}\n\n".to_vec();
    let (url, requests) = server(vec![
        reply(A, 200, descriptor(A)),
        reply(A, 200, descriptor(A)),
        stream,
    ]);
    fs::write(dir.join("endpoint"), &url).unwrap();
    let mut registry = Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    registry.fixture_identity = true;
    let messages = Arc::new(Mutex::new(Vec::new()));
    let received = messages.clone();
    let app = tauri::test::mock_builder()
        .manage(registry)
        .invoke_handler(tauri::generate_handler![
            environment_list,
            environment_register,
            environment_select,
            environment_query,
            environment_stream_events
        ])
        .channel_interceptor(move |_, callback, _, body| {
            received.lock().unwrap().push((
                callback.0,
                match body {
                    tauri::ipc::InvokeResponseBody::Json(text) => {
                        serde_json::from_str::<Value>(text).unwrap()
                    }
                    _ => panic!("expected JSON channel"),
                },
            ));
            true
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: Value| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    };
    let initial = invoke("environment_list", json!({})).unwrap();
    assert_eq!(initial["registry"]["version"], 1);
    assert_eq!(initial["registry"]["legacyMutationsRetired"], false);
    assert_eq!(initial["registry"]["environments"], json!({}));
    // Both optional registration flags are absent, not explicitly null.
    let registered = invoke(
        "environment_register",
        json!({"environmentId":A,"endpoint":url,"label":"IPC environment"}),
    )
    .unwrap();
    assert_eq!(registered["environments"][A]["activeRoute"], url);
    assert_eq!(registered["environments"][A]["environmentId"], A);
    assert_eq!(
        invoke("environment_select", json!({"environmentId":A})).unwrap()["selectedEnvironmentId"],
        A
    );
    assert!(invoke(
        "environment_query",
        json!({"environmentId":B,"kind":"snapshot","payload":{}})
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .contains("not registered"));
    invoke(
        "environment_stream_events",
        json!({"environmentId":A,"channel":"__CHANNEL__:7"}),
    )
    .unwrap();
    assert!(messages
        .lock()
        .unwrap()
        .iter()
        .any(|(id, message)| *id == 7 && message["type"] == "native-ipc-frame"));
    requests.join().unwrap();
    drop(webview);
    drop(app);
    fs::remove_dir_all(dir).unwrap();
}

// Open chunked SSE sockets controlled by the test, not finite canned responses or delay sleeps.
fn controlled_streams(
    id: &str,
    count: usize,
) -> (
    String,
    Vec<std::sync::mpsc::Sender<Option<u64>>>,
    std::thread::JoinHandle<()>,
) {
    controlled_streams_protocol(id, count, false)
}
fn controlled_streams_protocol(
    id: &str,
    count: usize,
    legacy: bool,
) -> (String, Vec<std::sync::mpsc::Sender<Option<u64>>>, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let id = id.to_owned();
    let mut senders = Vec::new();
    let mut receivers = Vec::new();
    for _ in 0..count {
        let (tx, rx) = std::sync::mpsc::channel();
        senders.push(tx);
        receivers.push(rx);
    }
    let thread = std::thread::spawn(move || {
        let mut workers = Vec::new();
        let mut streams = receivers.into_iter();
        loop {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline);
                        std::thread::yield_now();
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            let mut byte = [0; 1];
            while !data.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                data.push(byte[0]);
            }
            let headers = String::from_utf8(data).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|s| s.strip_prefix("content-length: "))
                .unwrap_or("0")
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            if !headers.starts_with("GET ") {
                let sig = headers
                    .lines()
                    .find_map(|s| s.strip_prefix("x-outpost-signature: "))
                    .unwrap();
                let sig =
                    ed25519_dalek::Signature::from_slice(&STANDARD.decode(sig).unwrap()).unwrap();
                SigningKey::from_bytes(&[7; 32])
                    .verifying_key()
                    .verify_strict(&body, &sig)
                    .unwrap();
                let value: Value = serde_json::from_slice(&body).unwrap();
                if legacy {
                    assert!(headers.starts_with("POST /v1/stream "));
                    assert_eq!(value["type"], "subscribe");
                    assert_eq!(value["payload"], json!({}));
                    assert!(value.get("environmentId").is_none());
                    assert!(value.get("protocolVersion").is_none());
                } else {
                    assert_eq!(value["environmentId"], id);
                    assert_eq!(value["protocolVersion"], 2);
                }
            }
            if !headers.starts_with(if legacy { "POST /v1/stream " } else { "POST /v2/stream " }) {
                let reply = descriptor(&id).to_string();
                write!(socket,"HTTP/1.1 200 OK\r\nx-outpost-environment-id: {id}\r\nx-outpost-protocol-version: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len()).unwrap();
                continue;
            }
            let receiver = streams.next().unwrap();
            let id = id.clone();
            workers.push(std::thread::spawn(move || {
                let binding = if legacy { String::new() } else { format!("x-outpost-environment-id: {id}\r\nx-outpost-protocol-version: 2\r\n") };
                write!(socket,"HTTP/1.1 200 OK\r\n{binding}Content-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
                let emit=|socket:&mut std::net::TcpStream,seq:u64| {
                    let frame=format!("data: {{\"sequence\":{seq}}}\n\n"); write!(socket,"{:x}\r\n{frame}\r\n",frame.len()).unwrap(); socket.flush().unwrap();
                };
                emit(&mut socket,0);
                while let Some(seq)=receiver.recv_timeout(Duration::from_secs(5)).unwrap() { emit(&mut socket,seq); }
                // Native cancellation must actually close an established socket.
                let mut buf=[0;1]; assert_eq!(socket.read(&mut buf).unwrap(),0);
            }));
            if workers.len() == count {
                break;
            }
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });
    (endpoint, senders, thread)
}
fn start_live(
    state: Arc<State>,
) -> (
    tauri::async_runtime::JoinHandle<Result<(), String>>,
    tokio::sync::mpsc::UnboundedReceiver<Value>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tauri::async_runtime::spawn(async move {
        state
            .bound_stream(tauri::ipc::Channel::new(move |body| {
                tx.send(body.deserialize::<Value>().unwrap()).unwrap();
                Ok(())
            }))
            .await
    });
    (task, rx)
}
async fn frame(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>, expected: u64) {
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap()["sequence"],
        expected
    );
}
async fn ended(task: tauri::async_runtime::JoinHandle<Result<(), String>>) {
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
#[test]
fn established_stream_replacement_disconnect_route_change_and_removal_leave_b_running() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let mut registry =
            Registry::new(dir.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
        registry.fixture_identity = true;
        let (url, a_controls, a_server) = controlled_streams(A, 2);
        registry
            .register(A.into(), url, "A".into(), None, true)
            .await
            .unwrap();
        let a = registry.get(A).unwrap();
        let (b_url, b_controls, b_server) = controlled_streams(B, 1);
        let b = Arc::new(connection(&dir, B, &b_url));
        let (b_task, mut b_frames) = start_live(b.clone());
        frame(&mut b_frames, 0).await;
        let (old, mut old_frames) = start_live(a.clone());
        frame(&mut old_frames, 0).await;
        let (replacement, mut replacement_frames) = start_live(a.clone());
        frame(&mut replacement_frames, 0).await;
        ended(old).await;
        a_controls[0].send(None).unwrap();
        assert!(old_frames.recv().await.is_none());
        b_controls[0].send(Some(1)).unwrap();
        frame(&mut b_frames, 1).await;
        a.cancel_stream().unwrap();
        ended(replacement).await;
        a_controls[1].send(None).unwrap();
        assert!(replacement_frames.recv().await.is_none());
        a_server.join().unwrap();
        let (url, controls, server) = controlled_streams(A, 1);
        registry
            .register(A.into(), url, "A next route".into(), None, false)
            .await
            .unwrap();
        let (active, mut active_frames) = start_live(a.clone());
        frame(&mut active_frames, 0).await;
        let (url, last_controls, last_server) = controlled_streams(A, 1);
        registry
            .register(A.into(), url, "A final route".into(), None, false)
            .await
            .unwrap();
        ended(active).await;
        controls[0].send(None).unwrap();
        assert!(active_frames.recv().await.is_none());
        server.join().unwrap();
        let (last, mut last_frames) = start_live(a.clone());
        frame(&mut last_frames, 0).await;
        registry.remove(A.into()).await.unwrap();
        ended(last).await;
        last_controls[0].send(None).unwrap();
        assert!(last_frames.recv().await.is_none());
        last_server.join().unwrap();
        b_controls[0].send(Some(2)).unwrap();
        frame(&mut b_frames, 2).await;
        b.cancel_stream().unwrap();
        ended(b_task).await;
        b_controls[0].send(None).unwrap();
        b_server.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn concurrent_stream_start_waits_for_atomic_route_activation() {
    let dir = directory();
    let state = Arc::new(connection(&dir, A, "http://127.0.0.1:1"));
    let (before, request) = state.prepare_stream().unwrap();
    assert_eq!(request.build().unwrap().url().port(), Some(1));
    let client = state.client.lock().unwrap();
    let changing = state.clone();
    let route = std::thread::spawn(move || {
        changing
            .activate_route("http://127.0.0.1:2".into())
            .unwrap()
    });
    // Holding client pauses route activation between cancellation and endpoint replacement.
    // It must retain the stream lifecycle lock throughout this boundary.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if state.stream.try_lock().is_err() {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let starting = state.clone();
    let start = std::thread::spawn(move || {
        entered_tx.send(()).unwrap();
        starting.prepare_stream().unwrap()
    });
    entered_rx.recv().unwrap();
    drop(client);
    route.join().unwrap();
    let (after, request) = start.join().unwrap();
    assert!(*before.borrow());
    assert!(!*after.borrow());
    assert_eq!(request.build().unwrap().url().port(), Some(2));
    state.cancel_stream().unwrap();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn legacy_stream_ipc_disconnect_reconnect_closes_sockets_without_cancelling_bound_b() {
    tauri::async_runtime::block_on(async {
        let dir = directory();
        let (url, legacy_controls, legacy_server) = controlled_streams_protocol(A, 2, true);
        fs::write(dir.join("endpoint"), url).unwrap();
        let legacy = State::new(dir.clone()).unwrap();
        identify(&legacy);
        let app = tauri::test::mock_builder()
            .manage(legacy)
            .invoke_handler(tauri::generate_handler![crate::transport::disconnect])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let start_legacy = || {
            let app = app.handle().clone();
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let task = tauri::async_runtime::spawn(async move {
                crate::transport::stream_events(app.state::<State>(), tauri::ipc::Channel::new(move |body| {
                    tx.send(body.deserialize::<Value>().unwrap()).unwrap();
                    Ok(())
                })).await
            });
            (task, rx)
        };
        let disconnect_legacy = || {
            tauri::test::get_ipc_response(&webview, tauri::webview::InvokeRequest {
                cmd: "disconnect".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(), body: tauri::ipc::InvokeBody::Json(json!({})),
                headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
            }).unwrap();
        };
        let (b_url, b_controls, b_server) = controlled_streams(B, 1);
        let b = Arc::new(connection(&dir, B, &b_url));
        let (b_task, mut b_frames) = start_live(b.clone());
        frame(&mut b_frames, 0).await;
        for (index, control) in legacy_controls.iter().enumerate() {
            let (task, mut frames) = start_legacy();
            frame(&mut frames, 0).await;
            control.send(Some(1)).unwrap();
            frame(&mut frames, 1).await;
            disconnect_legacy();
            ended(task).await;
            control.send(None).unwrap(); // The server checks EOF on the actual ongoing socket.
            assert!(frames.recv().await.is_none());
            b_controls[0].send(Some(index as u64 + 1)).unwrap();
            frame(&mut b_frames, index as u64 + 1).await;
        }
        legacy_server.join().unwrap();
        b.cancel_stream().unwrap();
        ended(b_task).await;
        b_controls[0].send(None).unwrap();
        b_server.join().unwrap();
        drop(webview);
        drop(app);
        fs::remove_dir_all(dir).unwrap();
    });
}
