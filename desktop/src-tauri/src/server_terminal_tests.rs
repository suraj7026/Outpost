use super::*;

pub(crate) const ENV: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
pub(crate) struct Fixture {
    pub setup: Setup,
    pub registry: environments::Registry,
    root: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        Self::for_environment(ENV)
    }
    pub fn for_environment(environment_id: &str) -> Self {
        let root = super::super::tests::root();
        let setup = Setup::new(root.clone()).unwrap();
        let mut bytes = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
        bytes.extend([9; 32]);
        let (key, fingerprint) = parse_key(&format!(
            "host.example ssh-ed25519 {}\n",
            STANDARD.encode(bytes)
        ))
        .unwrap();
        let id = Uuid::new_v4().to_string();
        setup.inner.lock().unwrap().challenges.insert(
            id.clone(),
            Challenge {
                scan: Scan {
                    id: id.clone(),
                    target: super::super::Target {
                        host: "host.example".into(),
                        user: "operator".into(),
                        port: 22,
                        identity_file: None,
                    },
                    fingerprint: fingerprint.clone(),
                },
                key,
                created: Instant::now(),
            },
        );
        setup
            .trust(id.clone(), fingerprint, "Fixture server".into())
            .unwrap();
        let inspection: Inspection = serde_json::from_value(json!({"version":1,"os":"ubuntu","osVersion":"24.04","architecture":"x86_64","systemd":true,"uid":1000,
            "freeBytes":21474836480_u64,"memoryBytes":4294967296_u64,"markers":[],"container":false,"sudo":"policy_readable","api":"environment","environment":{"environmentId":environment_id,"release":null}})).unwrap();
        setup
            .inner
            .lock()
            .unwrap()
            .entries
            .get_mut(&id)
            .unwrap()
            .inspection = Some(inspection);
        // Use the actual persisted registry format, not current selection or host inference.
        fs::create_dir(root.join("environments")).unwrap();
        fs::write(root.join("environments/registry.json"), serde_json::to_vec(&json!({
            "version":1,"legacyMutationsRetired":true,"selectedEnvironmentId":environment_id,
            "environments":{environment_id:{"environmentId":environment_id,"label":"Fixture","routes":["http://127.0.0.1:4318"],"activeRoute":"http://127.0.0.1:4318",
                "ssh":{"setupId":id,"route":"http://127.0.0.1:4318","paused":false,"generation":0}}}
        })).unwrap()).unwrap();
        let registry =
            environments::Registry::new(root.clone(), Arc::new(tokio::sync::Mutex::new(())))
                .unwrap();
        Self {
            setup,
            registry,
            root,
        }
    }
    pub fn bound(&self) -> BoundTarget {
        resolve(&self.setup, &self.registry, Some(ENV)).unwrap()
    }
    pub fn fake_ssh(&mut self, output: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = self.root.join("fake-ssh");
        fs::write(&path, format!("#!/bin/sh\nfor arg do last=\"$arg\"; done\n[ \"$last\" = '/bin/cat /proc/sys/kernel/random/boot_id' ] || exit 90\nprintf '%s\\n' '{output}'\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        self.setup.ssh_fixture = Some(path.to_str().unwrap().into());
    }
    pub fn break_pin(&self) {
        let id = self.bound().target.setup_id;
        fs::write(
            self.setup.directory.join(format!("{id}.known_hosts")),
            "changed",
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.setup.close();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn local(script: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", script]);
    command
}
fn wait_for(session: &Session, predicate: impl Fn(&Output) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if predicate(&session.output.lock().unwrap()) {
            return;
        }
        assert!(Instant::now() < deadline, "local PTY fixture timed out");
        thread::sleep(Duration::from_millis(10));
    }
}
fn text(output: &Output) -> String {
    String::from_utf8_lossy(&output.bytes.iter().copied().collect::<Vec<_>>()).into_owned()
}

#[test]
fn explicit_binding_required_and_trust_revalidated() {
    let fixture = Fixture::new();
    assert!(resolve(&fixture.setup, &fixture.registry, None).is_err());
    assert!(resolve(
        &fixture.setup,
        &fixture.registry,
        Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    )
    .is_err());
    let bound = fixture.bound();
    assert_eq!(bound.target.host, "host.example");
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&bound.target.setup_id)
        .unwrap()
        .target
        .user = "another".into();
    assert!(revalidate(&fixture.setup, &fixture.registry, &bound).is_err());
    let current = fixture.bound();
    fixture.break_pin();
    assert!(revalidate(&fixture.setup, &fixture.registry, &current).is_err());
}

#[test]
fn inspection_identity_must_match_saved_environment() {
    let fixture = Fixture::new();
    let bound = fixture.bound();
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&bound.target.setup_id)
        .unwrap()
        .inspection = None;
    assert!(resolve(&fixture.setup, &fixture.registry, Some(ENV)).is_err());
}

#[test]
fn argv_is_fixed_pinned_and_disables_local_ssh_escape_commands() {
    let fixture = Fixture::new();
    let args = ssh_args(&fixture.setup, &fixture.bound(), true).unwrap();
    for expected in [
        "-tt",
        "-oEscapeChar=none",
        "-oStrictHostKeyChecking=yes",
        "-oProxyCommand=none",
        "-oProxyJump=none",
        "-oControlPath=none",
        "-oClearAllForwardings=yes",
        "-oBatchMode=yes",
        "-oHostKeyAlgorithms=ssh-ed25519",
    ] {
        assert!(args.iter().any(|a| a == expected), "missing {expected}");
    }
    assert!(!args.iter().any(|a| a == "-T"));
    assert_eq!(&args[args.len() - 2..], &["--", "host.example"]);
    assert!(args.windows(2).any(|a| a == ["-F", "/dev/null"]));
    // -G is configuration output only; it does not resolve or connect to the fixture host.
    let mut config_args = args;
    config_args.insert(0, "-G".into());
    let output = Command::new("/usr/bin/ssh")
        .args(config_args)
        .output()
        .unwrap();
    assert!(output.status.success());
    let config = String::from_utf8(output.stdout).unwrap();
    assert!(config.contains("requesttty force"));
    assert!(config.contains("stricthostkeychecking true"));
    assert!(config.contains("escapechar none"));
    assert!(!config.contains("proxycommand sh"));
}

#[test]
fn output_ring_uses_absolute_byte_offsets_and_bounded_reads() {
    let mut output = Output::default();
    let bytes: Vec<u8> = (0..OUTPUT_CAP + 123).map(|i| (i % 256) as u8).collect();
    output.append(&bytes);
    assert_eq!(output.bytes.len(), OUTPUT_CAP);
    let first = output.read(0).unwrap();
    assert!(first.dropped);
    assert_eq!(first.next_offset, (123 + READ_CAP) as u64);
    assert_eq!(
        STANDARD.decode(first.data).unwrap(),
        bytes[123..123 + READ_CAP]
    );
    let second = output.read(first.next_offset).unwrap();
    assert!(!second.dropped);
    assert_eq!(
        STANDARD.decode(second.data).unwrap(),
        bytes[123 + READ_CAP..123 + READ_CAP * 2]
    );
    assert!(output.read(output.end + 1).is_err());
    assert!(output.read(output.end).unwrap().data.is_empty());
    output.append(b"\x00\xff\x1b[31m");
    assert_eq!(output.bytes.len(), OUTPUT_CAP);
}

#[test]
fn validates_dimensions_base64_and_input_limits() {
    for size in [(0, 24), (80, 0), (501, 24), (80, 301), (u32::MAX, u32::MAX)] {
        assert!(dimensions(size.0, size.1).is_err());
    }
    assert!(dimensions(500, 300).is_ok());
    assert!(decode_input("invalid!").is_err());
    assert_eq!(
        &*decode_input(&STANDARD.encode([0, 255, 27])).unwrap(),
        &[0, 255, 27]
    );
    assert!(decode_input(&STANDARD.encode(vec![0; INPUT_CAP])).is_ok());
    assert!(decode_input(&STANDARD.encode(vec![0; INPUT_CAP + 1])).is_err());
}

#[test]
fn local_pty_is_interactive_resizable_and_reports_exit_code() {
    let fixture = Fixture::new();
    let session = spawn(
        fixture.bound(),
        local("stty size; IFS= read -r line; stty size; printf 'received:%s\\n' \"$line\"; exit 7"),
        dimensions(80, 24).unwrap(),
    )
    .unwrap();
    wait_for(&session, |o| text(o).contains("24 80"));
    session
        .send(Input::Resize(dimensions(132, 42).unwrap()))
        .unwrap();
    session
        .send(Input::Bytes(Zeroizing::new(b"hello terminal\n".to_vec())))
        .unwrap();
    wait_for(&session, |o| o.exited);
    let output = session.output.lock().unwrap();
    let text = text(&output);
    assert!(text.contains("42 132"), "{text}");
    assert!(text.contains("received:hello terminal"), "{text}");
    assert_eq!(output.exit_code, Some(7));
}

#[test]
fn close_kills_and_reaps_child_and_is_idempotent() {
    let fixture = Fixture::new();
    let terminals = Terminals::default();
    let opened = terminals
        .open(
            fixture.bound(),
            local("echo $$; exec /bin/sleep 60"),
            dimensions(80, 24).unwrap(),
        )
        .unwrap();
    let session = terminals.get(&opened.session_id).unwrap();
    wait_for(&session, |o| text(o).contains('\n'));
    let pid: i32 = text(&session.output.lock().unwrap())
        .trim()
        .parse()
        .unwrap();
    let started = Instant::now();
    terminals.remove(&opened.session_id).unwrap();
    terminals.remove(&opened.session_id).unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(session.output.lock().unwrap().exited);
    // SAFETY: waitpid with WNOHANG never blocks or sends a signal. ECHILD proves reaping.
    assert_eq!(
        unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

#[test]
fn session_cap_is_atomic_and_shutdown_refuses_new_sessions() {
    let fixture = Fixture::new();
    let terminals = Arc::new(Terminals::default());
    let mut threads = Vec::new();
    for _ in 0..8 {
        let terminals = terminals.clone();
        let bound = fixture.bound();
        threads.push(thread::spawn(move || {
            terminals
                .open(
                    bound,
                    local("exec /bin/sleep 60"),
                    dimensions(80, 24).unwrap(),
                )
                .is_ok()
        }));
    }
    let successes = threads
        .into_iter()
        .map(|t| usize::from(t.join().unwrap()))
        .sum::<usize>();
    assert_eq!(successes, MAX_SESSIONS);
    terminals.close();
    assert!(terminals.inner.lock().unwrap().sessions.is_empty());
    assert!(terminals
        .open(
            fixture.bound(),
            local("exit 0"),
            dimensions(80, 24).unwrap()
        )
        .is_err());
}

#[test]
fn abandoned_session_is_killed_without_waiting_for_another_ipc_call() {
    let fixture = Fixture::new();
    let session = spawn(
        fixture.bound(),
        local("exec /bin/sleep 60"),
        dimensions(80, 24).unwrap(),
    )
    .unwrap();
    session.output.lock().unwrap().touched = Instant::now() - ABANDONED_AFTER;
    wait_for(&session, |o| o.exited);
    assert!(session
        .send(Input::Bytes(Zeroizing::new(b"x".to_vec())))
        .is_err());
}

#[test]
fn revoked_trust_closes_the_original_session_without_retargeting() {
    let fixture = Fixture::new();
    let terminals = Terminals::default();
    let opened = terminals
        .open(
            fixture.bound(),
            local("exec /bin/sleep 60"),
            dimensions(80, 24).unwrap(),
        )
        .unwrap();
    let session = terminals.get(&opened.session_id).unwrap();
    fixture.break_pin();
    assert!(checked_session(
        &terminals,
        &fixture.setup,
        &fixture.registry,
        &opened.session_id
    )
    .is_err());
    assert!(session.output.lock().unwrap().exited);
    assert!(terminals.get(&opened.session_id).is_err());
}

#[test]
fn drop_does_not_submit_partial_input_and_reaps_the_child() {
    let fixture = Fixture::new();
    let marker = fixture.root.join("submitted");
    let script = format!(
        "echo ready; IFS= read -r line; printf submitted > '{}'",
        marker.display()
    );
    let session = spawn(fixture.bound(), local(&script), dimensions(80, 24).unwrap()).unwrap();
    wait_for(&session, |o| text(o).contains("ready"));
    session
        .send(Input::Bytes(Zeroizing::new(b"partial".to_vec())))
        .unwrap();
    wait_for(&session, |o| text(o).contains("partial"));
    let output = session.output.clone();
    drop(session);
    assert!(output.lock().unwrap().exited);
    assert!(
        !marker.exists(),
        "disconnect must never add a newline or execute input"
    );
}

#[test]
fn blocked_remote_input_does_not_block_close() {
    let fixture = Fixture::new();
    let session = Arc::new(
        spawn(
            fixture.bound(),
            local("stty raw -echo; printf 'READY\\n'; exec /bin/sleep 60"),
            dimensions(80, 24).unwrap(),
        )
        .unwrap(),
    );
    wait_for(&session, |o| text(o).contains("READY"));
    let writing = session.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let result = (0..512)
            .try_for_each(|_| writing.send(Input::Bytes(Zeroizing::new(vec![b'x'; INPUT_CAP]))));
        done_tx.send(result).unwrap();
    });
    thread::sleep(Duration::from_millis(100));
    assert!(
        done_rx.try_recv().is_err(),
        "writer must be backpressured by the unread PTY"
    );
    let resizing = Instant::now();
    session
        .send(Input::Resize(dimensions(132, 42).unwrap()))
        .unwrap();
    assert!(resizing.elapsed() < Duration::from_millis(100));
    let started = Instant::now();
    session.stop();
    assert!(done_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .is_err());
    writer.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(session.output.lock().unwrap().exited);
}

#[test]
fn serialized_large_paste_crosses_queue_capacity_without_lost_or_replayed_bytes() {
    let fixture = Fixture::new();
    let session = spawn(
        fixture.bound(),
        local("stty raw -echo; printf 'READY\\n'; exec /bin/cat"),
        dimensions(80, 24).unwrap(),
    )
    .unwrap();
    wait_for(&session, |o| text(o).contains("READY\n"));
    let payload: Vec<u8> = (0..512 * 1024).map(|i| (i % 251) as u8).collect();
    assert!(payload.len() > QUEUE_CAP * INPUT_CAP);
    for (index, chunk) in payload.chunks(4096).enumerate() {
        // Mirrors the UI awaiting each write. Every returned success owns exactly one
        // accepted chunk, including the tail after the original 32-KiB queue boundary.
        session
            .send(Input::Bytes(Zeroizing::new(chunk.to_vec())))
            .unwrap();
        if index % 16 == 0 {
            session
                .send(Input::Resize(dimensions(100 + index as u32, 40).unwrap()))
                .unwrap();
        }
    }
    let expected = [b"READY\n".as_slice(), &payload].concat();
    wait_for(&session, |o| o.end >= expected.len() as u64);
    session.stop();
    assert_eq!(
        session
            .output
            .lock()
            .unwrap()
            .bytes
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        expected
    );
}

fn stalled_session(fixture: &Fixture) -> (Arc<Session>, Receiver<Input>) {
    let (sender, receiver) = mpsc::sync_channel(QUEUE_CAP);
    let session = Arc::new(Session {
        bound: fixture.bound(),
        output: Arc::new(Mutex::new(Output::default())),
        sender,
        resize: Arc::new(Mutex::new(None)),
        writes: Arc::new(tokio::sync::Semaphore::new(QUEUE_CAP)),
        cancel: Arc::new(AtomicBool::new(false)),
        worker: Mutex::new(None),
    });
    for n in 0..QUEUE_CAP {
        session
            .send(Input::Bytes(Zeroizing::new(vec![n as u8])))
            .unwrap();
    }
    (session, receiver)
}

#[test]
fn full_queue_has_bounded_timeout_and_coalesces_resize_without_accepting_the_tail() {
    let fixture = Fixture::new();
    let (session, receiver) = stalled_session(&fixture);
    for cols in 90..120 {
        session
            .send(Input::Resize(dimensions(cols, 40).unwrap()))
            .unwrap();
    }
    assert_eq!(
        *session.resize.lock().unwrap(),
        Some(dimensions(119, 40).unwrap())
    );
    let started = Instant::now();
    let error = session
        .send_until(
            Input::Bytes(Zeroizing::new(b"unaccepted tail".to_vec())),
            started + Duration::from_millis(40),
        )
        .unwrap_err();
    assert!(error.contains("timed out") && error.contains("not queued"));
    assert!(started.elapsed() >= Duration::from_millis(40));
    assert!(started.elapsed() < Duration::from_secs(1));
    let received: Vec<_> = receiver
        .try_iter()
        .map(|input| match input {
            Input::Bytes(bytes) => bytes[0],
            Input::Resize(_) => panic!("resize must not occupy input queue"),
        })
        .collect();
    assert_eq!(received, (0..QUEUE_CAP as u8).collect::<Vec<_>>());
}

#[test]
fn blocked_queue_wait_is_interrupted_by_disconnect_or_worker_exit() {
    let fixture = Fixture::new();
    for exited in [false, true] {
        let (session, receiver) = stalled_session(&fixture);
        let sending = session.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            done_tx
                .send(sending.send(Input::Bytes(Zeroizing::new(b"tail".to_vec()))))
                .unwrap();
        });
        thread::sleep(Duration::from_millis(20));
        assert!(done_rx.try_recv().is_err());
        let started = Instant::now();
        if exited {
            drop(receiver);
        } else {
            session.stop();
        }
        let result = done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(result.unwrap_err().contains("not queued"));
        writer.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}

#[test]
fn concurrent_ipc_write_admission_is_bounded_before_spawning_workers() {
    let fixture = Fixture::new();
    let (session, _receiver) = stalled_session(&fixture);
    let permits: Vec<_> = (0..QUEUE_CAP)
        .map(|_| session.writes.clone().try_acquire_owned().unwrap())
        .collect();
    assert!(session.writes.clone().try_acquire_owned().is_err());
    drop(permits);
    assert!(session.writes.clone().try_acquire_owned().is_ok());
}
