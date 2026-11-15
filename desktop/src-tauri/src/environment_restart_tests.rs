use super::*;
use std::{
    io::{Read, Write},
    sync::mpsc,
    thread,
    time::Instant,
};

const ENVIRONMENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn registration_server() -> (String, thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        for _ in 0..2 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "registration fixture timed out");
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .map_or(0, |v| v.parse::<usize>().unwrap());
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let body = super::super::tests::descriptor(ENVIRONMENT).to_string();
            write!(socket, "HTTP/1.1 200 OK\r\nx-outpost-environment-id: {ENVIRONMENT}\r\nx-outpost-protocol-version: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    (endpoint, worker)
}

#[test]
fn restart_registration_race_locks_the_new_current_state_through_authorization() {
    let root = std::env::temp_dir().join(format!("outpost-restart-race-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut registry = Registry::new(root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    registry.fixture_identity = true;
    let registry = Arc::new(registry);
    let (gate_seen, gate_seen_rx) = mpsc::channel();
    let (registered, registered_rx) = mpsc::channel();
    let (authorized, authorized_rx) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let copy = registry.clone();
    let worker = thread::spawn(move || {
        let fence = copy
            .reserve_restart_fence_with(ENVIRONMENT, || {
                gate_seen.send(()).unwrap();
                registered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            })
            .unwrap();
        authorized.send(()).unwrap();
        finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        copy.commit_restart_fence(&fence, &BTreeSet::new())
    });
    gate_seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (endpoint, server) = registration_server();
    tauri::async_runtime::block_on(registry.register_created(
        ENVIRONMENT.into(),
        endpoint,
        "Concurrent registration".into(),
    ))
    .unwrap();
    server.join().unwrap();
    registered.send(()).unwrap();
    authorized_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let current = registry.get(ENVIRONMENT).unwrap();
    // During the native dialog a new command must be excluded by THIS State's mutation gate.
    let command_guard = current.mutation.clone().try_lock_owned();
    let command_excluded = command_guard.is_err();
    if command_guard.is_ok() {
        let mut client = current.client.lock().unwrap();
        client.pending =
            Some(json!({"commandId":Uuid::new_v4().to_string(),"environmentId":ENVIRONMENT}));
        current.persist_pending(&client).unwrap();
    }
    drop(command_guard);
    finish.send(()).unwrap();
    let committed = worker.join().unwrap();
    assert!(command_excluded, "restart locked a stale or absent State; signed work escaped during authorization: {committed:?}");
    committed.unwrap();
    assert!(current.removed.load(Ordering::SeqCst));
    assert!(!current.route_available.load(Ordering::SeqCst));
    assert!(!root
        .join("environments")
        .join(ENVIRONMENT)
        .join("pending.enc")
        .exists());
    drop(registry);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn restart_commit_rechecks_pending_and_same_connection_under_reserved_guards() {
    let root = std::env::temp_dir().join(format!("outpost-restart-fence-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let registry = Registry::new(root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    let fence = registry.reserve_restart_fence(ENVIRONMENT).unwrap();
    let current = Arc::new(
        Registry::connection(
            &root.join("environments"),
            ENVIRONMENT,
            "https://fixture.example",
        )
        .unwrap(),
    );
    registry
        .inner
        .lock()
        .unwrap()
        .connections
        .insert(ENVIRONMENT.into(), current.clone());
    assert!(
        registry
            .validate_restart_fence(&fence, &BTreeSet::new())
            .is_err(),
        "a fence must remain bound to the exact locked State, including absence"
    );
    assert!(registry
        .commit_restart_fence(&fence, &BTreeSet::new())
        .is_err());
    drop(fence);
    let fence = registry.reserve_restart_fence(ENVIRONMENT).unwrap();
    current.client.lock().unwrap().pending = Some(json!({"fixture":"late pending"}));
    assert!(
        registry
            .commit_restart_fence(&fence, &BTreeSet::new())
            .is_err(),
        "late unresolved work must block durable disposal"
    );
    assert!(!current.removed.load(Ordering::SeqCst));
    drop(fence);
    drop(registry);
    fs::remove_dir_all(root).unwrap();
}
