use super::*;

fn target() -> Target {
    Target {
        host: "host.example".into(),
        user: "operator".into(),
        port: 22,
        identity_file: None,
    }
}
pub(crate) fn root() -> PathBuf {
    let path = std::env::temp_dir().join(format!("outpost-ssh-test-{}", Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    path
}
fn key() -> String {
    let mut bytes = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
    bytes.extend([9; 32]);
    format!("host.example ssh-ed25519 {}\n", STANDARD.encode(bytes))
}
fn trusted(setup: &Setup) -> Entry {
    let (key, fingerprint) = parse_key(&key()).unwrap();
    let id = Uuid::new_v4().to_string();
    setup.inner.lock().unwrap().challenges.insert(
        id.clone(),
        Challenge {
            scan: Scan {
                id: id.clone(),
                target: target(),
                fingerprint: fingerprint.clone(),
            },
            key,
            created: Instant::now(),
        },
    );
    setup
        .trust(id, fingerprint, "Fixture server".into())
        .unwrap()
}
fn inspection() -> Inspection {
    serde_json::from_value(json!({"version":1,"os":"ubuntu","osVersion":"24.04","architecture":"x86_64","systemd":true,"uid":1000,
        "freeBytes":20_u64*1024*1024*1024,"memoryBytes":4_u64*1024*1024*1024,"markers":[],"container":false,"sudo":"policy_readable","api":"absent","environment":null})).unwrap()
}
#[test]
fn ssh_targets_reject_options_shell_syntax_and_secret_material() {
    for host in [
        "-oProxyCommand=evil",
        "host;id",
        "user@host",
        "https://host",
        "host\nother",
        "$(id)",
        "[::1]",
    ] {
        let mut value = target();
        value.host = host.into();
        assert!(value.validate().is_err(), "{host}");
    }
    for host in ["host.example", "192.0.2.10", "2001:db8::1"] {
        let mut value = target();
        value.host = host.into();
        assert!(value.validate().is_ok());
    }
    let mut value = target();
    value.user = "-root".into();
    assert!(value.validate().is_err());
    value = target();
    value.port = 0;
    assert!(value.validate().is_err());
    value = target();
    value.identity_file = Some("-----BEGIN PRIVATE KEY-----".into());
    assert!(value.validate().is_err());
}
#[test]
fn host_fingerprint_is_bound_to_one_key_and_explicit_confirmation() {
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    assert!(parse_key(&(key() + &key())).is_err());
    assert!(parse_key("host ssh-ed25519 AAAA").is_err());
    assert!(parse_key("host ssh-rsa AAAA").is_err());
    let entry = trusted(&setup);
    assert!(entry.fingerprint.starts_with("SHA256:"));
    let args = setup.ssh_args(&entry).unwrap();
    assert!(args.contains(&"-oStrictHostKeyChecking=yes".into()));
    assert!(args.contains(&"-oForwardAgent=no".into()));
    assert!(args.contains(&"/dev/null".into()));
    assert!(!args
        .iter()
        .any(|arg| arg.contains("StrictHostKeyChecking=no")));
    fs::write(
        setup.directory.join(format!("{}.known_hosts", entry.id)),
        "changed",
    )
    .unwrap();
    assert!(setup.ssh_args(&entry).is_err());
    drop(setup);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn actual_openssh_config_preserves_private_paths_with_spaces_without_network() {
    let dir = root();
    let support = dir.join("Application Support");
    fs::create_dir(&support).unwrap();
    let setup = Setup::new(support).unwrap();
    let entry = trusted(&setup);
    let mut args = setup.ssh_args(&entry).unwrap();
    assert!(args
        .iter()
        .any(|arg| arg.starts_with("-oUserKnownHostsFile=\"") && arg.ends_with('"')));
    args.extend(["-G".into(), "--".into(), entry.target.host.clone()]);
    // ssh -G prints configuration and exits: it does not resolve/connect to this synthetic host.
    let bytes = run(
        "/usr/bin/ssh",
        &args,
        b"",
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text
        .lines()
        .any(|line| line.starts_with("userknownhostsfile ")
            && line.contains("Application Support/server-setup/")));
    assert!(text.contains("stricthostkeychecking true"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn detection_never_treats_existing_data_or_kubernetes_as_a_fresh_install() {
    let mut value = inspection();
    value.validate().unwrap();
    assert_eq!(value.recommendation(), "fresh_install_candidate");
    for marker in [
        "etc/kubernetes",
        "var/lib/kubelet",
        "var/lib/docker",
        "var/lib/containerd",
    ] {
        value.markers = vec![marker.into()];
        assert_eq!(value.recommendation(), "migration_review");
    }
    value.markers = vec!["var/lib/outpost".into()];
    assert_eq!(value.recommendation(), "ambiguous_installation");
    value.markers = vec!["etc/rancher/k3s".into()];
    assert_eq!(value.recommendation(), "migration_review");
    value.environment = Some(Environment {
        environment_id: Uuid::new_v4().to_string(),
        release: Some("fixture".into()),
    });
    value.api = "environment".into();
    assert_eq!(
        value.recommendation(),
        "migration_review",
        "Even a working API does not authorize a deployment migration"
    );
    value.markers.clear();
    assert_eq!(value.recommendation(), "connect_existing");
    value = inspection();
    value.container = true;
    assert_eq!(value.recommendation(), "migration_review");
    value = inspection();
    value.api = "legacy_or_other".into();
    assert_eq!(value.recommendation(), "ambiguous_installation");
    value = inspection();
    value.architecture = "aarch64".into();
    assert_eq!(value.recommendation(), "unsupported_host");
    value = inspection();
    value.memory_bytes = 512;
    assert_eq!(value.recommendation(), "insufficient_capacity");
}
#[test]
fn setup_restart_records_interruption_and_never_repeats_an_operation() {
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let entry = trusted(&setup);
    setup
        .record(&entry.id, "inspecting", "Inspection began")
        .unwrap();
    drop(setup);
    let restored = Setup::new(dir.clone()).unwrap();
    let saved = restored.list().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].phase, "interrupted");
    assert!(saved[0].endpoint.is_none());
    assert!(restored.inner.lock().unwrap().running.is_empty());
    assert!(restored.inner.lock().unwrap().tunnels.is_empty());
    drop(restored);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn cancellation_only_marks_the_owned_operation_and_journal_errors_fail_closed() {
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let a = trusted(&setup);
    let b = trusted(&setup);
    let (_, first) = setup.begin(&a.id).unwrap();
    let (_, second) = setup.begin(&b.id).unwrap();
    assert!(setup.begin(&a.id).is_err());
    setup.disconnect(&a.id).unwrap();
    assert!(first.load(Ordering::SeqCst));
    assert!(!second.load(Ordering::SeqCst));
    setup.close();
    assert!(second.load(Ordering::SeqCst));
    drop(setup);
    fs::write(dir.join("server-setup/entries.json"), "not-json").unwrap();
    assert!(Setup::new(dir.clone()).is_err());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn local_processes_are_bounded_and_failure_output_is_not_reflected() {
    let cancelled = AtomicBool::new(false);
    let start = Instant::now();
    assert!(run(
        "/bin/sleep",
        &["5".into()],
        b"",
        Duration::from_millis(50),
        &cancelled
    )
    .is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
    let error = run(
        "/bin/sh",
        &["-c".into(), "printf synthetic-secret >&2; exit 1".into()],
        b"",
        Duration::from_secs(2),
        &cancelled,
    )
    .unwrap_err();
    assert!(!error.contains("synthetic-secret"));
    cancelled.store(true, Ordering::SeqCst);
    assert!(run(
        "/bin/sleep",
        &["5".into()],
        b"",
        Duration::from_secs(2),
        &cancelled
    )
    .is_err());
}
pub(crate) fn tunnel_fixture(setup: &mut Setup, environment: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = setup.directory.join("fake-ssh");
    let descriptor = environments::tests::descriptor(environment).to_string();
    let log = setup
        .directory
        .join("fixture-requests")
        .display()
        .to_string();
    let reject = setup.directory.join("fixture-reject").display().to_string();
    fs::write(
        &path,
        format!(
            r##"#!/usr/bin/python3
import http.server, json, sys, threading, pathlib
port = int(sys.argv[sys.argv.index('-L') + 1].split(':')[1])
environment = {environment:?}
descriptor = json.loads({descriptor:?})
class Handler(http.server.BaseHTTPRequestHandler):
    def respond(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('x-outpost-environment-id', environment)
        self.send_header('x-outpost-protocol-version', '2')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self.respond(200, descriptor)
    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path == '/v2/query' and value['type'] == 'environment'
        assert value['environmentId'] == environment and value['protocolVersion'] == 2
        assert len(self.headers['x-outpost-signature']) == 88
        with open({log:?}, 'a') as f: f.write(json.dumps(value) + '\n')
        if pathlib.Path({reject:?}).exists(): self.respond(403, {{'message':'Device enrollment revoked'}})
        else: self.respond(200, descriptor)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print('outpost-forward-ready', flush=True)
sys.stdin.read()
server.shutdown()
"##
        ),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    setup.ssh_fixture = Some(path.display().to_string());
}
pub(crate) fn inspected(setup: &Setup, environment: &str) -> Entry {
    let entry = trusted(setup);
    let mut value = inspection();
    value.api = "environment".into();
    value.environment = Some(Environment {
        environment_id: environment.into(),
        release: Some("fixture".into()),
    });
    setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&entry.id)
        .unwrap()
        .inspection = Some(value);
    entry
}
#[test]
fn owned_forward_processes_verify_identity_and_disconnect_independently() {
    tauri::async_runtime::block_on(async {
        let dir = root();
        let mut setup = Setup::new(dir.clone()).unwrap();
        let environment = Uuid::new_v4().to_string();
        tunnel_fixture(&mut setup, &environment);
        let a = inspected(&setup, &environment);
        let b = inspected(&setup, &environment);
        let first = setup.tunnel(&a.id).await.unwrap();
        let second = setup.tunnel(&b.id).await.unwrap();
        assert_eq!(first.phase, "tunnel_ready");
        assert_ne!(first.endpoint, second.endpoint);
        assert_eq!(setup.inner.lock().unwrap().tunnels.len(), 2);
        setup.disconnect(&a.id).unwrap();
        assert_eq!(setup.inner.lock().unwrap().tunnels.len(), 1);
        let client = reqwest::Client::new();
        assert!(client
            .get(format!("{}/v2/environment", first.endpoint.unwrap()))
            .send()
            .await
            .is_err());
        assert!(client
            .get(format!("{}/v2/environment", second.endpoint.unwrap()))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        setup.close();
        assert!(setup.inner.lock().unwrap().tunnels.is_empty());
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn forwarded_identity_mismatch_fails_without_saving_or_leaving_a_process() {
    tauri::async_runtime::block_on(async {
        let dir = root();
        let mut setup = Setup::new(dir.clone()).unwrap();
        tunnel_fixture(&mut setup, &Uuid::new_v4().to_string());
        let entry = inspected(&setup, &Uuid::new_v4().to_string());
        assert!(setup
            .tunnel(&entry.id)
            .await
            .unwrap_err()
            .contains("identity changed"));
        assert!(setup.inner.lock().unwrap().tunnels.is_empty());
        assert!(setup.list().unwrap()[0].endpoint.is_none());
        setup.close();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn unavailable_setup_does_not_reinitialize_a_damaged_journal() {
    let dir = root();
    let setup = Setup::unavailable(dir.clone(), "Journal requires recovery".into());
    assert!(setup.list().is_err());
    assert!(setup.scan(target()).is_err());
    assert!(!dir.join("server-setup").exists());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn private_key_files_must_be_private_regular_files() {
    use std::os::unix::fs::PermissionsExt;
    let dir = root();
    let path = dir.join("identity");
    fs::write(&path, "synthetic fixture only").unwrap();
    let mut value = target();
    value.identity_file = Some(path.display().to_string());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(value.check_key().is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(value.check_key().is_ok());
    let link = dir.join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    value.identity_file = Some(link.display().to_string());
    assert!(value.check_key().is_err());
    fs::remove_dir_all(dir).unwrap();
}

fn export_fixture(setup: &Setup, label: &str) -> Entry {
    let mut entry = trusted(setup);
    entry.label = label.into();
    entry.phase = "installation_stopped".into();
    entry.error = Some(format!("{label} setup error"));
    entry.log = vec![format!("{label} setup log")];
    entry.inspection = Some(inspection());
    let operation = Uuid::new_v4().to_string();
    let environment = Uuid::new_v4().to_string();
    let release = format!("host-{}", "a".repeat(20));
    entry.plan = Some(
        serde_json::from_value(json!({
            "planId": Uuid::new_v4().to_string(), "operationId": operation,
            "environmentId": environment, "releaseId": release, "sha256": "b".repeat(64),
            "size": 17, "expiresAt": 100, "browser": false, "fullControl": true,
            "coexistenceRequired": false, "deviceId": Uuid::new_v4().to_string(),
            "publicKey": STANDARD.encode([7; 32]), "nodeVersion": "24.22.1",
        }))
        .unwrap(),
    );
    entry.installation = Some(serde_json::from_value(json!({
        "operationId": operation, "environmentId": environment, "releaseId": release,
        "state": "failed", "completedSteps": 4, "totalSteps": 12,
        "stage": "Install dependencies", "startedAt": 1, "updatedAt": 2,
        "error": format!("{label} installation error"), "log": [format!("{label} installation log")],
    })).unwrap());
    setup
        .inner
        .lock()
        .unwrap()
        .entries
        .insert(entry.id.clone(), entry.clone());
    entry
}

fn export_downloads(root: &std::path::Path) -> PathBuf {
    let downloads = root.join("fixture-downloads");
    fs::create_dir(&downloads).unwrap();
    downloads
}

#[test]
fn setup_export_log_is_entry_scoped_and_omits_key_material() {
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let downloads = export_downloads(&dir);
    let mut entry = export_fixture(&setup, "Selected fixture");
    let other = export_fixture(&setup, "Unrelated fixture");
    let identity = dir.join("private-identity-must-not-be-exported");
    fs::write(&identity, "SYNTHETIC PRIVATE KEY CONTENT NEVER EXPORT").unwrap();
    entry.target.identity_file = Some(identity.display().to_string());
    {
        let mut inner = setup.inner.lock().unwrap();
        inner.entries.insert(entry.id.clone(), entry.clone());
        setup.persist(&inner).unwrap();
    }
    let journal = fs::read(setup.directory.join("entries.json")).unwrap();
    let saved = PathBuf::from(setup.export_log(&entry.id, &downloads).unwrap());
    assert_eq!(
        saved.parent().unwrap(),
        downloads.join("Outpost/setup-logs")
    );
    let report = fs::read_to_string(&saved).unwrap();
    for expected in [
        "Outpost setup diagnostic log",
        "Inspection",
        "Reviewed installation plan",
        "Installation receipt",
        &entry.id,
        &entry.label,
        &entry.target.host,
        &entry.target.user,
        &entry.fingerprint,
        "\"port\": 22",
        "ubuntu",
        "24.04",
        "installation_stopped",
        "Selected fixture setup error",
        "Selected fixture setup log",
        "Selected fixture installation error",
        "Selected fixture installation log",
        "Install dependencies",
        "\"completedSteps\": 4",
        "\"totalSteps\": 12",
    ] {
        assert!(report.contains(expected), "Missing {expected}");
    }
    let plan = serde_json::to_value(&entry.plan).unwrap();
    for field in ["operationId", "environmentId", "releaseId"] {
        assert!(report.contains(plan[field].as_str().unwrap()));
    }
    let other_plan = serde_json::to_value(&other.plan).unwrap();
    for omitted in [
        &other.id,
        &other.label,
        other_plan["operationId"].as_str().unwrap(),
        other_plan["environmentId"].as_str().unwrap(),
        identity.to_str().unwrap(),
        "SYNTHETIC PRIVATE KEY CONTENT NEVER EXPORT",
        "identityFile",
        "publicKey",
        plan["publicKey"].as_str().unwrap(),
        plan["deviceId"].as_str().unwrap(),
        plan["sha256"].as_str().unwrap(),
        key().split_whitespace().nth(2).unwrap(),
    ] {
        assert!(!report.contains(omitted), "Leaked {omitted}");
    }
    assert_eq!(
        fs::read(setup.directory.join("entries.json")).unwrap(),
        journal
    );
    assert_eq!(
        serde_json::to_value(setup.entry(&entry.id).unwrap()).unwrap(),
        serde_json::to_value(&entry).unwrap()
    );
    assert!(setup.inner.lock().unwrap().running.is_empty());
    assert!(setup.inner.lock().unwrap().tunnels.is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn setup_export_log_filename_is_sanitized_and_ids_cannot_traverse_paths() {
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let downloads = export_downloads(&dir);
    let entry = trusted(&setup);
    for label in [
        "../../escape",
        "..\\..\\escape",
        "/tmp/absolute",
        "...",
        "服务器",
        "bad\n\0\u{1b}label",
    ] {
        setup
            .inner
            .lock()
            .unwrap()
            .entries
            .get_mut(&entry.id)
            .unwrap()
            .label = label.into();
        let path = PathBuf::from(setup.export_log(&entry.id, &downloads).unwrap());
        assert_eq!(path.parent().unwrap(), downloads.join("Outpost/setup-logs"));
        let filename = path.file_name().unwrap().to_str().unwrap();
        assert!(filename.starts_with("outpost-setup-"));
        assert!(filename.ends_with(".txt"));
        assert!(filename.len() < 140);
        assert!(!filename.contains(".."));
        assert!(filename
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-.".contains(&c)));
        let report = fs::read_to_string(path).unwrap();
        assert!(!report.contains(['\0', '\u{1b}']));
    }
    let count = fs::read_dir(downloads.join("Outpost/setup-logs"))
        .unwrap()
        .count();
    for id in ["../escape", "/tmp/escape", "..\\escape", "\0", "not-an-id"] {
        assert!(setup.export_log(id, &downloads).is_err());
    }
    assert!(setup
        .export_log(&format!("{}/../escape", entry.id), &downloads)
        .is_err());
    assert_eq!(
        fs::read_dir(downloads.join("Outpost/setup-logs"))
            .unwrap()
            .count(),
        count
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn setup_export_log_files_and_owned_directory_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let downloads = export_downloads(&dir);
    let entry = trusted(&setup);
    let first = PathBuf::from(setup.export_log(&entry.id, &downloads).unwrap());
    for path in [
        downloads.join("Outpost"),
        downloads.join("Outpost/setup-logs"),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert_eq!(
        fs::metadata(&first).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::set_permissions(first.parent().unwrap(), fs::Permissions::from_mode(0o755)).unwrap();
    let second = PathBuf::from(setup.export_log(&entry.id, &downloads).unwrap());
    assert_eq!(
        fs::metadata(&second).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(second.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(fs::read_to_string(first).unwrap().contains("Not recorded"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn setup_export_log_never_overwrites_existing_exports_or_links() {
    use std::os::unix::fs::symlink;
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let downloads = export_downloads(&dir);
    let entry = trusted(&setup);
    let first = PathBuf::from(setup.export_log(&entry.id, &downloads).unwrap());
    fs::write(&first, "Retained earlier export").unwrap();
    let second = PathBuf::from(setup.export_log(&entry.id, &downloads).unwrap());
    assert_ne!(first, second);
    assert!(private_setup_log_write(&first, b"Must not overwrite").is_err());
    let link = first.parent().unwrap().join("existing-link.txt");
    symlink(&first, &link).unwrap();
    assert!(private_setup_log_write(&link, b"Must not overwrite link").is_err());
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    let missing = dir.join("must-not-create.txt");
    let dangling = first.parent().unwrap().join("dangling-link.txt");
    symlink(&missing, &dangling).unwrap();
    assert!(private_setup_log_write(&dangling, b"Must not follow link").is_err());
    assert!(!missing.exists());
    assert_eq!(
        fs::read_to_string(&first).unwrap(),
        "Retained earlier export"
    );
    assert_eq!(fs::read_dir(first.parent().unwrap()).unwrap().count(), 4);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn setup_export_log_rejects_unknown_unavailable_or_mismatched_entries_without_writing() {
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let downloads = export_downloads(&dir);
    let entry = trusted(&setup);
    assert!(setup
        .export_log(&Uuid::new_v4().to_string(), &downloads)
        .unwrap_err()
        .contains("Unknown setup target"));
    let unavailable = Setup::unavailable(dir.clone(), "Journal unavailable".into());
    assert!(unavailable
        .export_log(&entry.id, &downloads)
        .unwrap_err()
        .contains("Journal unavailable"));
    setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&entry.id)
        .unwrap()
        .id = Uuid::new_v4().to_string();
    assert!(setup
        .export_log(&entry.id, &downloads)
        .unwrap_err()
        .contains("identity mismatch"));
    setup.close();
    assert!(setup
        .export_log(&entry.id, &downloads)
        .unwrap_err()
        .contains("stopping"));
    assert!(fs::read_dir(&downloads).unwrap().next().is_none());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn setup_export_log_rejects_blocked_and_symlinked_output_directories() {
    use std::os::unix::fs::symlink;
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let entry = trusted(&setup);
    assert!(setup
        .export_log(&entry.id, &dir.join("missing-downloads"))
        .is_err());
    let blocked = dir.join("not-a-directory");
    fs::write(&blocked, "Retain file").unwrap();
    assert!(setup.export_log(&entry.id, &blocked).is_err());
    assert_eq!(fs::read_to_string(&blocked).unwrap(), "Retain file");
    for component in ["Outpost", "Outpost/setup-logs"] {
        for is_link in [false, true] {
            let downloads = dir.join(Uuid::new_v4().to_string());
            fs::create_dir(&downloads).unwrap();
            let path = downloads.join(component);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let outside = dir.join(Uuid::new_v4().to_string());
            fs::create_dir(&outside).unwrap();
            if is_link {
                symlink(&outside, &path).unwrap();
            } else {
                fs::write(&path, "Existing output blocker").unwrap();
            }
            assert!(setup.export_log(&entry.id, &downloads).is_err());
            assert!(fs::read_dir(&outside).unwrap().next().is_none());
            if !is_link {
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    "Existing output blocker"
                );
            }
        }
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn setup_export_log_reports_durability_errors_and_cleans_up_staging() {
    struct ResetHook;
    impl Drop for ResetHook {
        fn drop(&mut self) {
            DIRECTORY_SYNC_HOOK.with(|hook| *hook.borrow_mut() = None);
        }
    }
    let dir = root();
    let path = dir.join("synthetic-export.txt");
    let reset = ResetHook;
    DIRECTORY_SYNC_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|_| Err("Injected export sync failure".into())))
    });
    let error = private_setup_log_write(&path, b"Complete, private report").unwrap_err();
    drop(reset);
    assert!(error.contains("Injected export sync failure"));
    // Publication may have succeeded before the durability barrier failed. Do not
    // report success, overwrite it on retry, or leave temporary report copies.
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Complete, private report"
    );
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    assert!(private_setup_log_write(&path, b"Retry must not overwrite").is_err());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}
