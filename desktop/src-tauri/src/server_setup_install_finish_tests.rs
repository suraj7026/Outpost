//! Owned loopback HTTP and synthetic SSH fixtures; no Keychain, app or remote host.
use super::*;

fn registration_server(environment: String, reject: bool) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for signed in [false, true] {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "fixture timed out");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture: {error}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            let (body_start, length) = loop {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .map(|length| length.parse::<usize>().unwrap())
                        .unwrap_or(0);
                    break (end + 4, length);
                }
            };
            while bytes.len() < body_start + length {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
            }
            let headers = String::from_utf8_lossy(&bytes[..body_start]);
            if signed {
                assert!(headers.starts_with("POST /v2/query "));
                let signature = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("x-outpost-signature: "))
                    .unwrap();
                let signature =
                    ed25519_dalek::Signature::from_slice(&STANDARD.decode(signature).unwrap())
                        .unwrap();
                let body = &bytes[body_start..body_start + length];
                SigningKey::from_bytes(&[7; 32])
                    .verifying_key()
                    .verify_strict(body, &signature)
                    .unwrap();
                let packet: Value = serde_json::from_slice(body).unwrap();
                assert_eq!(packet["type"], "environment");
                assert_eq!(packet["environmentId"], environment);
                assert_eq!(packet["protocolVersion"], 2);
            } else {
                assert!(headers.starts_with("GET /v2/environment "));
            }
            assert!(!headers.contains("/pair"));
            let status = if signed && reject { 401 } else { 200 };
            let body = if status == 200 {
                environments::tests::descriptor(&environment)
            } else {
                json!({"message":"synthetic rejection"})
            }
            .to_string();
            write!(socket,"HTTP/1.1 {status} Fixture\r\nx-outpost-environment-id: {environment}\r\nx-outpost-protocol-version: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    (endpoint, server)
}

#[test]
fn app_handle_free_finish_requires_signed_registration_before_native_completion() {
    for reject in [false, true] {
        let (root, setup, entry, _) = tests::fixture();
        let setup = Arc::new(setup);
        let plan = entry.plan.as_ref().unwrap();
        let progress: InstallProgress = serde_json::from_value(json!({"operationId":plan.operation_id,"environmentId":plan.environment_id,
            "releaseId":plan.release_id,"state":"ready","completedSteps":10,"totalSteps":12,"stage":"Private connection",
            "startedAt":1,"updatedAt":2,"log":[],"error":null})).unwrap();
        fs::write(
            root.join("receipt.json"),
            serde_json::to_vec(&progress).unwrap(),
        )
        .unwrap();
        setup
            .store_install(&entry.id, progress, InstallProgressSource::Remote)
            .unwrap();
        let (endpoint, server) = registration_server(plan.environment_id.clone(), reject);
        setup
            .inner
            .lock()
            .unwrap()
            .entries
            .get_mut(&entry.id)
            .unwrap()
            .endpoint = Some(endpoint);
        let identity_state = State::new(root.clone()).unwrap();
        let mut registry =
            environments::Registry::new(root.clone(), identity_state.mutation_gate()).unwrap();
        registry.fixture_identity = true;
        fs::write(
            root.join("pending.enc"),
            b"preserve unrelated original recovery",
        )
        .unwrap();
        let result = tauri::async_runtime::block_on(setup.finish_install(&registry, &entry.id));
        server.join().unwrap();
        let current = setup.entry(&entry.id).unwrap().installation.unwrap();
        if reject {
            assert!(result.is_err());
            assert_eq!(current.state, "ready");
            assert_eq!(current.completed_steps, 10);
            assert!(registry.get(&plan.environment_id).is_err());
        } else {
            result.unwrap();
            assert_eq!(current.state, "complete");
            assert_eq!(current.completed_steps, 12);
            assert!(registry.get(&plan.environment_id).is_ok());
        }
        assert_eq!(
            fs::read(root.join("pending.enc")).unwrap(),
            b"preserve unrelated original recovery"
        );
        let metadata: Value =
            serde_json::from_slice(&fs::read(root.join("environments/registry.json")).unwrap())
                .unwrap();
        assert_eq!(metadata["legacyMutationsRetired"], false);
        setup.close();
        fs::remove_dir_all(root).unwrap();
    }
}
