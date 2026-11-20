use super::*;
const ENVIRONMENT: &str = "11111111-1111-4111-8111-111111111111";
const DEVICE: &str = "22222222-2222-4222-8222-222222222222";
const OPERATION: &str = "33333333-3333-4333-8333-333333333333";
fn artifact() -> Value {
    let key = SigningKey::from_bytes(&[23; 32]);
    let manifest = json!({"schema":2,"id":"host-aaaaaaaaaaaaaaaaaaaa","protocolVersion":2,"layoutVersion":1,"compatibility":"native-v1","sequence":6,"piVersion":"1.0.0","extensions":[],"rollback":true});
    let signed = json!({"schema":1,"manifest":manifest,"sha256":"a".repeat(64),"size":16,"runtimePinsSha256":"b".repeat(64),"requiredTools":["automation.list","automation.save","automation.set_paused"]});
    let bytes = serde_json::to_vec(&signed).unwrap();
    json!({"schema":1,"id":manifest["id"],"manifest":manifest,"sha256":signed["sha256"],"size":signed["size"],"runtimePinsSha256":signed["runtimePinsSha256"],"authorization":{"payload":STANDARD.encode(&bytes),"signature":STANDARD.encode(key.sign(&bytes).to_bytes()),"publisherPublicKey":STANDARD.encode(key.verifying_key().to_bytes())}})
}
fn resign(artifact: &mut Value, payload: Value) {
    let key = SigningKey::from_bytes(&[23; 32]);
    let bytes = serde_json::to_vec(&payload).unwrap();
    artifact["authorization"]["payload"] = json!(STANDARD.encode(&bytes));
    artifact["authorization"]["signature"] = json!(STANDARD.encode(key.sign(&bytes).to_bytes()));
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("outpost-auto-update-test-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn journal() -> Journal {
    let mut journal = Journal::default();
    let mut server = Server::new(ENVIRONMENT.into());
    server.operation_id = Some(OPERATION.into());
    server.release_id = Some("host-aaaaaaaaaaaaaaaaaaaa".into());
    journal.servers.insert(ENVIRONMENT.into(), server);
    journal.targets.push(ENVIRONMENT.into());
    journal.enabled = true;
    journal
}
fn receipt(state: &str) -> Value {
    json!({"environmentId":ENVIRONMENT,"operationId":OPERATION,"artifact":{"id":"host-aaaaaaaaaaaaaaaaaaaa"},"state":state})
}
#[test]
fn unsigned_changed_or_wrongly_pinned_releases_are_refused() {
    let artifact = artifact();
    assert!(verify_authorization(&artifact, None).is_ok());
    assert!(verify_authorization(&artifact, Some("different")).is_err());
    let mut unsigned = artifact.clone();
    unsigned.as_object_mut().unwrap().remove("authorization");
    assert!(verify_authorization(&unsigned, None).is_err());
    for field in ["manifest", "sha256", "size", "runtimePinsSha256", "id"] {
        let mut changed = artifact.clone();
        changed[field] = Value::Null;
        assert!(verify_authorization(&changed, None).is_err(), "{field}");
    }
    let mut changed = artifact.clone();
    changed["authorization"]["signature"] = json!(STANDARD.encode([0; 64]));
    assert!(verify_authorization(&changed, None).is_err());
}
#[test]
fn publisher_payload_requires_exact_fields_and_complete_tools() {
    let mut artifact = artifact();
    let original = verify_authorization(&artifact, None).unwrap();
    let mut payload = original.clone();
    payload["extra"] = json!(true);
    resign(&mut artifact, payload);
    assert!(verify_authorization(&artifact, None).is_err());
    let mut payload = original.clone();
    payload["requiredTools"] = json!(["automation.list"]);
    resign(&mut artifact, payload);
    assert!(verify_authorization(&artifact, None).is_err());
    let mut payload = original.clone();
    payload["requiredTools"] = json!([
        "automation.list",
        "automation.save",
        "automation.set_paused",
        "automation.list"
    ]);
    resign(&mut artifact, payload);
    assert!(verify_authorization(&artifact, None).is_err());
    let mut payload = original;
    payload["schema"] = json!(true);
    resign(&mut artifact, payload);
    assert!(verify_authorization(&artifact, None).is_err());
}
#[test]
fn device_signature_covers_exact_request_bytes_and_all_bindings() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let artifact = artifact();
    let request = json!({"environmentId":ENVIRONMENT,"deviceId":DEVICE,"operationId":OPERATION,"releaseId":artifact["id"],"expectedRelease":"host-bbbbbbbbbbbbbbbbbbbb","sha256":artifact["sha256"],"size":artifact["size"],"target":artifact["manifest"]});
    let frame = sign_request(&request, &artifact["authorization"], &key).unwrap();
    assert_eq!(frame.last(), Some(&b'\n'));
    assert_eq!(frame.iter().filter(|b| **b == b'\n').count(), 1);
    let header: Value = serde_json::from_slice(&frame).unwrap();
    assert_eq!(header.as_object().unwrap().len(), 3);
    let bytes = STANDARD
        .decode(header["requestBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, serde_json::to_vec(&request).unwrap());
    let signature =
        Signature::from_bytes(&decode_fixed(header["deviceSignature"].as_str().unwrap()).unwrap());
    key.verifying_key()
        .verify_strict(&bytes, &signature)
        .unwrap();
    for field in [
        "environmentId",
        "deviceId",
        "operationId",
        "releaseId",
        "expectedRelease",
        "sha256",
        "size",
        "target",
    ] {
        let mut modified = request.clone();
        modified[field] = Value::Null;
        assert!(
            key.verifying_key()
                .verify_strict(&serde_json::to_vec(&modified).unwrap(), &signature)
                .is_err(),
            "{field}"
        );
    }
}
#[test]
fn durable_reservation_survives_restart_and_disable() {
    let fixture = Fixture::new();
    let mut journal = journal();
    journal.hold(ENVIRONMENT, Phase::Authorizing, "reserved");
    journal.write(&fixture.0).unwrap();
    let mut restored = Journal::read(&fixture.0).unwrap();
    assert_eq!(restored.active_environment_id.as_deref(), Some(ENVIRONMENT));
    assert_eq!(restored.servers[ENVIRONMENT].state, Phase::Authorizing);
    restored.enabled = false;
    restored.write(&fixture.0).unwrap();
    let restored = Journal::read(&fixture.0).unwrap();
    assert!(!restored.enabled);
    assert!(restored.active_environment_id.is_some());
}
#[test]
fn corrupt_or_unowned_journal_never_becomes_default() {
    let fixture = Fixture::new();
    assert!(!Journal::read(&fixture.0).unwrap().enabled);
    fs::write(fixture.0.join(JOURNAL), b"{").unwrap();
    assert!(Journal::read(&fixture.0).is_err());
    let mut j = journal();
    j.servers.get_mut(ENVIRONMENT).unwrap().state = Phase::Updating;
    assert!(j.write(&fixture.0).is_err());
    j.servers.get_mut(ENVIRONMENT).unwrap().state = Phase::Ready;
    j.schema = 2;
    assert!(j.write(&fixture.0).is_err());
}
#[cfg(unix)]
#[test]
fn symlink_journal_is_rejected() {
    let fixture = Fixture::new();
    let other = fixture.0.join("other.json");
    fs::write(&other, b"{}").unwrap();
    std::os::unix::fs::symlink(&other, fixture.0.join(JOURNAL)).unwrap();
    assert!(Journal::read(&fixture.0).is_err());
}
#[test]
fn global_guard_excludes_all_targets_and_releases_on_drop() {
    const CHILD: &str = "OUTPOST_TEST_UPDATE_GLOBAL_GUARD_CHILD";
    const VERIFIED: &str = "isolated production global guard verified";
    if std::env::var(CHILD).as_deref() != Ok("1") {
        // Exercise the production singleton in a process containing only this test.
        // Parallel command tests cannot take GLOBAL, and unrelated subprocess forks
        // cannot temporarily inherit this test's flock descriptor before exec.
        let executable = std::env::current_exe().unwrap();
        let module = module_path!().split_once("::").unwrap().1;
        let output = run(
            "/usr/bin/env",
            &[
                format!("{CHILD}=1"),
                executable.to_str().unwrap().into(),
                "--exact".into(),
                format!("{module}::global_guard_excludes_all_targets_and_releases_on_drop"),
                "--nocapture".into(),
            ],
            b"",
            Duration::from_secs(15),
            &AtomicBool::new(false),
        )
        .expect("Isolated global-guard assertions must pass");
        assert!(
            String::from_utf8_lossy(&output).contains(VERIFIED),
            "Isolated guard test did not execute: {}",
            String::from_utf8_lossy(&output)
        );
        return;
    }
    let fixture = Fixture::new();
    let other_target = Fixture::new();
    let guard = acquire_global(&fixture.0).unwrap();
    assert!(acquire_global(&fixture.0).is_err());
    assert!(acquire_global(&other_target.0).is_err());
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let second = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(fixture.0.join("automatic-updates.lock"))
            .unwrap();
        assert_ne!(
            unsafe { libc::flock(second.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
    }
    drop(guard);
    let reacquired =
        acquire_global(&fixture.0).expect("Dropping the guard must release both locks");
    assert!(acquire_global(&other_target.0).is_err());
    drop(reacquired);
    assert!(acquire_global(&other_target.0).is_ok());
    assert!(acquire_global(&fixture.0.join("missing-directory")).is_err());
    assert!(
        acquire_global(&fixture.0).is_ok(),
        "A failed file-lock acquisition must release GLOBAL"
    );
    println!("{VERIFIED}");
}
#[test]
fn uncertain_receipts_keep_queue_reserved_while_terminal_failures_isolate_to_server() {
    for (state, phase) in [
        ("unknown", Phase::Unknown),
        ("needs_attention", Phase::NeedsAttention),
        ("recovering", Phase::Updating),
    ] {
        let mut journal = journal();
        apply_progress(&mut journal, ENVIRONMENT, &receipt(state)).unwrap();
        assert_eq!(journal.servers[ENVIRONMENT].state, phase);
        assert_eq!(journal.active_environment_id.as_deref(), Some(ENVIRONMENT));
    }
    for (state, phase) in [("failed", Phase::Failed), ("rolled_back", Phase::RolledBack)] {
        let mut journal = journal();
        journal.active_environment_id = Some(ENVIRONMENT.into());
        apply_progress(&mut journal, ENVIRONMENT, &receipt(state)).unwrap();
        assert_eq!(journal.servers[ENVIRONMENT].state, phase);
        assert!(journal.active_environment_id.is_none());
    }
}
#[test]
fn completion_requires_postverification_not_next_server_launch() {
    let mut journal = journal();
    apply_progress(&mut journal, ENVIRONMENT, &receipt("complete")).unwrap();
    assert_eq!(journal.servers[ENVIRONMENT].state, Phase::Verifying);
    assert!(journal.active_environment_id.is_some());
    let mut wrong = receipt("complete");
    wrong["operationId"] = json!(DEVICE);
    assert!(apply_progress(&mut journal, ENVIRONMENT, &wrong).is_err());
    assert_eq!(journal.servers[ENVIRONMENT].state, Phase::Verifying);
}
#[test]
fn enrollment_only_loads_pinned_bundled_modules_and_fixed_no_arg_launcher() {
    assert_eq!(LAUNCH, "sudo -n -- /usr/local/libexec/outpost-update");
    assert!(isolated_python(BOOTSTRAP_LOADER).starts_with("/usr/bin/python3 -I -c "));
    assert!(isolated_python(BOOTSTRAP_LOADER).len() < 4096);
    let policy = policy(ENVIRONMENT, DEVICE, &STANDARD.encode([7; 32]), "operator");
    let source = enrollment_source(&policy, None, None).unwrap();
    assert!(source.contains(".enroll(p,raw['auto_update'],raw['host_update'],raw['common'])"));
    assert!(source.contains(&sha(HELPER.as_bytes())));
    assert!(source.contains(&sha(COMMON.as_bytes())));
    assert!(source.contains(&sha(UPDATER.as_bytes())));
    assert_eq!(policy.as_object().unwrap().len(), 4);
    let public = public_policy(&policy);
    assert_eq!(public["sourcesSha256"].as_object().unwrap().len(), 3);
    assert!(!POLICY_PROBE.contains("enroll("));
    assert!(!POLICY_PROBE.contains("--bootstrap"));
    assert!(!SERVICE_PROBE.contains("sudo"));
    assert!(!SERVICE_PROBE.contains("host-token"));
    assert!(!SERVICE_PROBE.contains("/v1"));
}

#[test]
fn stdin_bootstrap_loader_preserves_binary_update_frame() {
    let source="import sys,json\nassert sys.argv[1:]==['--bootstrap']\nassert json.loads(sys.stdin.buffer.readline())=={'operation':'fixture'}\nassert sys.stdin.buffer.read()==bytes([0,255,10,13,127])\nprint('frame intact')\n";
    let mut input = STANDARD.encode(source).into_bytes();
    input.push(b'\n');
    input.extend_from_slice(b"{\"operation\":\"fixture\"}\n");
    input.extend([0, 255, 10, 13, 127]);
    let output = run(
        "python3",
        &[
            "-I".into(),
            "-c".into(),
            BOOTSTRAP_LOADER.into(),
            "--bootstrap".into(),
        ],
        &input,
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(output, b"frame intact\n");
}
#[test]
fn manual_start_and_check_preserve_reserved_or_corrupt_receipts() {
    let fixture = Fixture::new();
    let setup = Setup::new(fixture.0.clone()).unwrap();
    let mut j = journal();
    j.hold(ENVIRONMENT, Phase::Unknown, "uncertain");
    j.write(&setup.directory).unwrap();
    assert!(reserved_environment(&setup, ENVIRONMENT).unwrap());
    assert!(allow_manual_start(&setup, ENVIRONMENT).is_err());
    assert!(allow_manual_start(&setup, DEVICE).is_err());
    save(&setup, ENVIRONMENT, &receipt("unknown")).unwrap();
    assert_eq!(
        optional_review(&setup, ENVIRONMENT).unwrap().unwrap()["state"],
        "unknown"
    );
    assert!(unresolved_manual(&setup, None).is_err());
    fs::write(path(&setup, ENVIRONMENT).unwrap(), b"{").unwrap();
    assert!(optional_review(&setup, ENVIRONMENT).is_err());
    assert!(unresolved_manual(&setup, None).is_err());
    fs::write(setup.directory.join(JOURNAL), b"{").unwrap();
    assert!(reserved_environment(&setup, ENVIRONMENT).is_err());
    assert!(allow_manual_start(&setup, DEVICE).is_err());
}
#[test]
fn cached_completion_or_wrong_release_cannot_release_the_queue() {
    let j = journal();
    let server = &j.servers[ENVIRONMENT];
    let mut review = receipt("complete");
    review["hostStatusVerified"] = json!(true);
    review["progress"] = json!({"environmentId":ENVIRONMENT,"operationId":OPERATION,"releaseId":server.release_id,"state":"complete"});
    assert!(verify_completion_receipt(&review, server, ENVIRONMENT).is_ok());
    let mut missing = review.clone();
    missing["hostStatusVerified"] = json!(false);
    assert!(verify_completion_receipt(&missing, server, ENVIRONMENT).is_err());
    for field in ["environmentId", "operationId", "releaseId", "state"] {
        let mut wrong = review.clone();
        wrong["progress"][field] = json!("wrong");
        assert!(verify_completion_receipt(&wrong, server, ENVIRONMENT).is_err());
    }
    let mut rollback = review.clone();
    rollback["state"] = json!("rolled_back");
    assert!(verify_completion_receipt(&rollback, server, ENVIRONMENT).is_err());
}
fn checked_journal() -> (Journal, Value) {
    let mut journal = journal();
    let server = journal.servers.get_mut(ENVIRONMENT).unwrap();
    server.state = Phase::Checked;
    server.policy = Some(public_policy(&policy(
        ENVIRONMENT,
        DEVICE,
        &STANDARD.encode([7; 32]),
        "operator",
    )));
    server.review_id = Some(DEVICE.into());
    let mut review = receipt("review");
    review["available"] = json!(true);
    review["reviewId"] = json!(DEVICE);
    review["expiresAt"] = json!(1000);
    (journal, review)
}
#[test]
fn disabled_expired_changed_and_offline_reservations_never_launch() {
    let (mut journal, review) = checked_journal();
    assert!(should_launch(&journal, ENVIRONMENT, Some(&review), 100));
    journal.enabled = false;
    assert!(!should_launch(&journal, ENVIRONMENT, Some(&review), 100));
    journal.enabled = true;
    assert!(!should_launch(&journal, ENVIRONMENT, Some(&review), 1001));
    assert!(!should_launch(&journal, ENVIRONMENT, None, 100));
    for field in [
        "environmentId",
        "reviewId",
        "operationId",
        "artifact",
        "available",
    ] {
        let mut changed = review.clone();
        changed[field] = Value::Null;
        assert!(!should_launch(&journal, ENVIRONMENT, Some(&changed), 100));
    }
    journal.active_environment_id = Some(DEVICE.into());
    assert!(!should_launch(&journal, ENVIRONMENT, Some(&review), 100));
}
#[test]
fn healthy_server_proceeds_when_another_target_is_failed_blocked_or_rolled_back() {
    let (mut journal, review) = checked_journal();
    let mut other = Server::new(DEVICE.into());
    other.policy = journal.servers[ENVIRONMENT].policy.clone();
    other.operation_id = Some(OPERATION.into());
    other.review_id = Some(DEVICE.into());
    other.release_id = Some("host-aaaaaaaaaaaaaaaaaaaa".into());
    let mut other_review = review.clone();
    other_review["environmentId"] = json!(DEVICE);
    for phase in [Phase::Failed, Phase::RolledBack, Phase::Blocked] {
        other.state = phase.clone();
        journal.servers.insert(DEVICE.into(), other.clone());
        journal.targets = vec![ENVIRONMENT.into(), DEVICE.into()];
        assert!(
            should_launch(&journal, ENVIRONMENT, Some(&review), 100),
            "Server B should proceed when Server A is {phase:?}"
        );
        assert!(
            !should_launch(&journal, DEVICE, Some(&other_review), 100),
            "Server A itself must not relaunch while {phase:?}"
        );
    }
    // Global pause remains when another server is Unknown/Enrolling or owns active_environment_id.
    for phase in [Phase::Unknown, Phase::Enrolling] {
        other.state = phase.clone();
        journal.servers.insert(DEVICE.into(), other.clone());
        journal.targets = vec![ENVIRONMENT.into(), DEVICE.into()];
        assert!(
            !should_launch(&journal, ENVIRONMENT, Some(&review), 100),
            "Server B must stay paused when Server A is {phase:?}"
        );
    }
    other.state = Phase::NeedsAttention;
    journal.servers.insert(DEVICE.into(), other);
    journal.active_environment_id = Some(DEVICE.into());
    assert!(!should_launch(&journal, ENVIRONMENT, Some(&review), 100));
}
#[test]
fn failed_or_unknown_receipts_are_adopted_not_replaced() {
    for (phase, holds_queue) in [
        ("failed", false),
        ("rolled_back", false),
        ("unknown", true),
        ("authorizing", true),
        ("waiting_for_idle", true),
    ] {
        let mut journal = journal();
        let review = receipt(phase);
        adopt_receipt(&mut journal, ENVIRONMENT, &review).unwrap();
        let expected_owner = holds_queue.then_some(ENVIRONMENT);
        assert_eq!(journal.active_environment_id.as_deref(), expected_owner);
        assert_eq!(
            journal.servers[ENVIRONMENT].operation_id.as_deref(),
            Some(OPERATION)
        );
        assert!(!should_launch(&journal, ENVIRONMENT, Some(&review), 0));
        let fixture = Fixture::new();
        journal.write(&fixture.0).unwrap();
        assert_eq!(
            Journal::read(&fixture.0)
                .unwrap()
                .active_environment_id
                .as_deref(),
            expected_owner
        );
    }
}
#[test]
fn public_status_exact_frontend_shape_omits_absent_release() {
    let mut journal = Journal::default();
    journal
        .servers
        .insert(ENVIRONMENT.into(), Server::new(ENVIRONMENT.into()));
    let status = journal.status();
    assert_eq!(status.as_object().unwrap().len(), 4);
    assert_eq!(status["enabled"], false);
    assert_eq!(status["targets"], json!([]));
    assert!(status["activeEnvironmentId"].is_null());
    let server = &status["servers"][0];
    assert_eq!(server["environmentId"], ENVIRONMENT);
    assert_eq!(server["state"], "not_enabled");
    assert!(server["message"].is_string());
    assert!(server.get("releaseId").is_none());
    journal.servers.get_mut(ENVIRONMENT).unwrap().release_id =
        Some("host-aaaaaaaaaaaaaaaaaaaa".into());
    assert!(journal.status()["servers"][0]["releaseId"].is_string());
    let serialized = serde_json::to_string(&status).unwrap();
    assert!(!serialized.contains("publisherPublicKey"));
    assert!(!serialized.contains("password"));
}
#[test]
fn signed_selection_prefers_complete_release_and_rejects_unsigned_downgrade() {
    let host = artifact();
    let source = "host-bbbbbbbbbbbbbbbbbbbb";
    let installed = family_installation(source, 5);
    let probe = json!({"releaseId":source,"runtimePinsSha256":host["runtimePinsSha256"]});
    let mut legacy = host.clone();
    legacy.as_object_mut().unwrap().remove("authorization");
    legacy["updateScope"] = json!("pi-only");
    legacy["sourceRelease"] = json!(source);
    assert_eq!(
        select_artifact(&installed, &probe, &host, Some(&legacy))
            .unwrap()
            .unwrap()
            .0,
        ArtifactResource::Host
    );
    let mut mismatch = host.clone();
    let mut payload = verify_authorization(&host, None).unwrap();
    payload["runtimePinsSha256"] = json!("c".repeat(64));
    mismatch["runtimePinsSha256"] = payload["runtimePinsSha256"].clone();
    resign(&mut mismatch, payload);
    assert!(
        select_artifact(&installed, &probe, &mismatch, Some(&legacy))
            .unwrap()
            .is_none()
    );
    mismatch["authorization"]["signature"] = json!(STANDARD.encode([0; 64]));
    assert!(select_artifact(&installed, &probe, &mismatch, Some(&legacy)).is_err());
}
fn family_installation(id: &str, sequence: u64) -> Value {
    let mut manifest = artifact()["manifest"].clone();
    manifest["id"] = json!(id);
    manifest["sequence"] = json!(sequence);
    json!({"releaseId":id,"manifest":manifest})
}
fn compatible_bundle() -> Value {
    let mut bundle = artifact();
    bundle["updateScope"] = json!("compatible-server");
    bundle["sourceRelease"] = json!("host-bbbbbbbbbbbbbbbbbbbb");
    bundle["compatibleSourceReleases"] =
        json!(["host-bbbbbbbbbbbbbbbbbbbb", "host-41cd62017ed6c74b5248"]);
    bundle
}
fn different_family_host() -> Value {
    let mut host = artifact();
    let mut payload = verify_authorization(&host, None).unwrap();
    payload["runtimePinsSha256"] = json!("c".repeat(64));
    host["runtimePinsSha256"] = payload["runtimePinsSha256"].clone();
    resign(&mut host, payload);
    host
}
fn family_probe(installed: &Value, artifact: &Value) -> Value {
    json!({"releaseId":installed["releaseId"],"runtimePinsSha256":artifact["runtimePinsSha256"]})
}
fn compatible_review(installed: &Value, probe: &Value, artifact: &Value) -> Value {
    json!({"artifactResource":"pi-release","installed":installed,"runtimePinsProbe":probe,"artifact":artifact})
}
#[test]
fn compatible_server_admits_unlisted_same_pin_family_and_latest_source() {
    let bundle = compatible_bundle();
    let host = different_family_host();
    validate_artifact(&bundle, ArtifactResource::Pi).unwrap();
    for id in ["host-dddddddddddddddddddd", "host-41cd62017ed6c74b5248"] {
        let installed = family_installation(id, 5);
        let probe = family_probe(&installed, &bundle);
        assert_eq!(
            select_artifact(&installed, &probe, &host, Some(&bundle))
                .unwrap()
                .unwrap()
                .0,
            ArtifactResource::Pi
        );
        assert!(newer_artifact(&installed, &bundle));
        assert_eq!(
            review_archive(&compatible_review(&installed, &probe, &bundle)).unwrap(),
            "pi-release.tar.gz"
        );
    }
    assert!(!pi_source_releases(&bundle)
        .unwrap()
        .contains(&"host-dddddddddddddddddddd"));
}
#[test]
fn compatible_server_requires_signature_even_for_explicit_source() {
    let source = family_installation("host-bbbbbbbbbbbbbbbbbbbb", 5);
    let bundle = compatible_bundle();
    let probe = family_probe(&source, &bundle);
    for alteration in ["missing", "signature", "payload"] {
        let mut changed = bundle.clone();
        match alteration {
            "missing" => {
                changed.as_object_mut().unwrap().remove("authorization");
            }
            "signature" => changed["authorization"]["signature"] = json!(STANDARD.encode([0; 64])),
            _ => changed["manifest"]["sequence"] = json!(7),
        }
        assert!(validate_artifact(&changed, ArtifactResource::Pi).is_err());
        assert!(
            select_artifact(&source, &probe, &different_family_host(), Some(&changed)).is_err()
        );
        assert!(review_archive(&compatible_review(&source, &probe, &changed)).is_err());
    }
}
#[test]
fn compatible_server_refuses_pin_identity_protocol_and_layout_changes() {
    let bundle = compatible_bundle();
    let host = different_family_host();
    let installed = family_installation("host-dddddddddddddddddddd", 5);
    let probe = family_probe(&installed, &bundle);
    for (field, value) in [
        ("schema", json!(1)),
        ("protocolVersion", json!(3)),
        ("layoutVersion", json!(2)),
        ("compatibility", json!("native-v2")),
        ("rollback", json!(false)),
        ("sequence", json!(true)),
    ] {
        let mut changed = installed.clone();
        changed["manifest"][field] = value;
        assert!(
            select_artifact(&changed, &probe, &host, Some(&bundle)).is_err(),
            "{field}"
        );
        assert!(
            review_archive(&compatible_review(&changed, &probe, &bundle)).is_err(),
            "{field}"
        );
    }
    let mut wrong_probe = probe.clone();
    wrong_probe["runtimePinsSha256"] = json!("d".repeat(64));
    assert!(
        select_artifact(&installed, &wrong_probe, &host, Some(&bundle))
            .unwrap()
            .is_none()
    );
    assert!(review_archive(&compatible_review(&installed, &wrong_probe, &bundle)).is_err());
    wrong_probe = probe.clone();
    wrong_probe["releaseId"] = json!("host-eeeeeeeeeeeeeeeeeeee");
    assert!(select_artifact(&installed, &wrong_probe, &host, Some(&bundle)).is_err());
    assert!(review_archive(&compatible_review(&installed, &wrong_probe, &bundle)).is_err());
    assert!(review_archive(&compatible_review(&installed, &Value::Null, &bundle)).is_err());
}
#[test]
fn equal_current_release_can_enroll_but_equal_older_and_same_id_cannot_update() {
    let bundle = compatible_bundle();
    let host = different_family_host();
    for (id, sequence) in [
        ("host-aaaaaaaaaaaaaaaaaaaa", 6),
        ("host-dddddddddddddddddddd", 6),
        ("host-dddddddddddddddddddd", 7),
        ("host-aaaaaaaaaaaaaaaaaaaa", 5),
    ] {
        let installed = family_installation(id, sequence);
        let probe = family_probe(&installed, &bundle);
        assert_eq!(
            enrollment_artifact(&installed, &probe, &host, Some(&bundle)).unwrap()["id"],
            bundle["id"]
        );
        assert!(!newer_artifact(&installed, &bundle));
        assert!(review_archive(&compatible_review(&installed, &probe, &bundle)).is_err());
    }
    let installed = family_installation("host-aaaaaaaaaaaaaaaaaaaa", 6);
    let probe = family_probe(&installed, &artifact());
    assert!(enrollment_artifact(&installed, &probe, &artifact(), None).is_ok());
}
#[test]
fn legacy_pi_only_keeps_source_allowlist_even_if_signed() {
    let mut bundle = compatible_bundle();
    bundle["updateScope"] = json!("pi-only");
    let installed = family_installation("host-dddddddddddddddddddd", 5);
    let probe = family_probe(&installed, &bundle);
    assert!(
        select_artifact(&installed, &probe, &different_family_host(), Some(&bundle))
            .unwrap()
            .is_none()
    );
    assert!(review_archive(&compatible_review(&installed, &probe, &bundle)).is_err());
    bundle.as_object_mut().unwrap().remove("authorization");
    let mut host = different_family_host();
    host.as_object_mut().unwrap().remove("authorization");
    assert!(select_artifact(&installed, &probe, &host, Some(&bundle))
        .unwrap()
        .is_none());
    assert!(review_archive(&compatible_review(&installed, &probe, &bundle)).is_err());
    let listed = family_installation("host-bbbbbbbbbbbbbbbbbbbb", 5);
    let listed_probe = family_probe(&listed, &bundle);
    assert_eq!(
        select_artifact(&listed, &listed_probe, &host, Some(&bundle))
            .unwrap()
            .unwrap()
            .0,
        ArtifactResource::Pi
    );
    assert!(review_archive(&compatible_review(&listed, &listed_probe, &bundle)).is_ok());
}
#[test]
fn compatible_server_provenance_is_validated_without_becoming_admission_list() {
    let mut bundle = compatible_bundle();
    let installed = family_installation("host-dddddddddddddddddddd", 5);
    let probe = family_probe(&installed, &bundle);
    bundle["compatibleSourceReleases"] = json!([bundle["sourceRelease"]]);
    assert!(review_archive(&compatible_review(&installed, &probe, &bundle)).is_ok());
    bundle["compatibleSourceReleases"] = json!([]);
    assert!(validate_artifact(&bundle, ArtifactResource::Pi).is_err());
    bundle["compatibleSourceReleases"] = json!(["not-a-release"]);
    assert!(validate_artifact(&bundle, ArtifactResource::Pi).is_err());
}
#[test]
fn compatible_server_message_does_not_claim_coordinator_preservation() {
    let message = release_review_message(ArtifactResource::Pi, &compatible_bundle());
    assert!(message.contains("compatible-server"));
    assert!(message
        .contains("Coordinator, worker, host executor and required tools are updated together"));
    assert!(!message.contains("Coordinator and browser source"));
}
#[test]
fn frontend_passive_states_remain_unreserved_and_holds_remain_explicit() {
    let (mut journal, _) = checked_journal();
    for (phase, expected) in [
        (Phase::Ready, "idle"),
        (Phase::Checked, "checked"),
        (Phase::Blocked, "blocked"),
    ] {
        journal.servers.get_mut(ENVIRONMENT).unwrap().state = phase;
        assert_eq!(journal.status()["servers"][0]["state"], expected);
        assert!(journal.status()["activeEnvironmentId"].is_null());
    }
    journal.enabled = false;
    assert_eq!(journal.status()["servers"][0]["state"], "not_enabled");
    journal.hold(ENVIRONMENT, Phase::Unknown, "inspect only");
    assert_eq!(journal.status()["activeEnvironmentId"], ENVIRONMENT);
    assert_eq!(journal.status()["servers"][0]["state"], "unknown");
}
struct PostverifyFixture {
    server: Server,
    review: Value,
    environment: Value,
    runtime: Value,
    inventory: Value,
    observed: Value,
}
impl PostverifyFixture {
    fn new(id: &str) -> Self {
        let artifact = artifact();
        let signed = verify_authorization(&artifact, None).unwrap();
        let services = json!([
            {"unit":"outpost-native-worker.service","pid":101,"restarts":2},
            {"unit":"outpost-native-coordinator.service","pid":102,"restarts":1},
            {"unit":"outpost-native-host.service","pid":103,"restarts":0},
        ]);
        let mut server = Server::new(id.into());
        server.state = Phase::Verifying;
        server.operation_id = Some(Uuid::new_v4().to_string());
        server.review_id = Some(Uuid::new_v4().to_string());
        server.release_id = artifact["id"].as_str().map(String::from);
        server.policy = Some(public_policy(&policy(
            id,
            DEVICE,
            artifact["authorization"]["publisherPublicKey"]
                .as_str()
                .unwrap(),
            "operator",
        )));
        let review = json!({"environmentId":id,"operationId":server.operation_id,"reviewId":server.review_id,"artifact":artifact,"state":"complete","hostStatusVerified":true,
            "progress":{"environmentId":id,"operationId":server.operation_id,"releaseId":artifact["id"],"state":"complete",
                "health":{"releaseId":artifact["id"],"stableSeconds":8,"requiredTools":signed["requiredTools"],"services":services}}});
        let environment = json!({"environmentId":id,"runtime":{"release":artifact["id"]}});
        let runtime = json!({"piManagement":true,"hostAdministration":true});
        let inventory = json!({"releaseId":artifact["id"],"manifest":artifact["manifest"]});
        let observed = json!({"environmentId":id,"releaseId":artifact["id"],"manifest":artifact["manifest"],"runtimePinsSha256":artifact["runtimePinsSha256"],"services":services,"stableSeconds":8.1,"observations":5,"fullControl":true,"hostAuthEnforced":true});
        Self {
            server,
            review,
            environment,
            runtime,
            inventory,
            observed,
        }
    }
    fn verify(&self, tools: Option<&Value>) -> Result<(), String> {
        verify_postupdate_health(
            &self.review,
            &self.server,
            &self.server.environment_id,
            LiveVerification {
                environment: &self.environment,
                runtime: &self.runtime,
                inventory: &self.inventory,
                services: &self.observed,
                tools,
            },
        )
    }
}
#[test]
fn taskless_root_catalogue_evidence_advances_two_server_queue_without_relaunch() {
    let first = PostverifyFixture::new(ENVIRONMENT);
    let second = PostverifyFixture::new(DEVICE);
    let mut journal = Journal::default();
    journal.enabled = true;
    journal.targets = vec![ENVIRONMENT.into(), DEVICE.into()];
    journal
        .servers
        .insert(ENVIRONMENT.into(), first.server.clone());
    let mut queued = second.server.clone();
    queued.state = Phase::Checked;
    journal.servers.insert(DEVICE.into(), queued);
    journal.active_environment_id = Some(ENVIRONMENT.into());
    let mut second_review = second.review.clone();
    second_review["state"] = json!("review");
    second_review["available"] = json!(true);
    second_review["expiresAt"] = json!(1000);
    assert!(!should_launch(&journal, DEVICE, Some(&second_review), 0));
    finish_verification(&mut journal, ENVIRONMENT, first.verify(None)).unwrap();
    let fixture = Fixture::new();
    journal.write(&fixture.0).unwrap();
    let mut journal = Journal::read(&fixture.0).unwrap();
    assert_eq!(journal.servers[ENVIRONMENT].state, Phase::Complete);
    assert!(!should_launch(
        &journal,
        ENVIRONMENT,
        Some(&first.review),
        0
    ));
    assert!(should_launch(&journal, DEVICE, Some(&second_review), 0));
    // Simulate the next server's existing updater reaching completion, not launching
    // a process in the test. Both verifications have no task/history/tool query.
    journal.servers.insert(DEVICE.into(), second.server.clone());
    journal.active_environment_id = Some(DEVICE.into());
    finish_verification(&mut journal, DEVICE, second.verify(None)).unwrap();
    journal.write(&fixture.0).unwrap();
    let journal = Journal::read(&fixture.0).unwrap();
    assert!(journal.active_environment_id.is_none());
    assert!(journal
        .servers
        .values()
        .all(|server| server.state == Phase::Complete));
}
#[test]
fn rebooted_services_with_new_pids_and_reset_counters_pass_fresh_stability() {
    let mut fixture = PostverifyFixture::new(ENVIRONMENT);
    for (index, service) in fixture.observed["services"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        service["pid"] = json!(5000 + index);
        service["restarts"] = json!(0);
    }
    assert_ne!(
        fixture.observed["services"],
        fixture.review["progress"]["health"]["services"]
    );
    assert!(fixture.verify(None).is_ok());
    fixture.observed["services"][0]["restarts"] = json!(7);
    assert!(fixture.verify(None).is_ok());
}
#[test]
fn missing_or_incomplete_root_catalogue_evidence_holds_without_retrying_launch() {
    for tools in [
        Value::Null,
        json!([]),
        json!(["automation.list"]),
        json!([
            "automation.list",
            "automation.save",
            "automation.set_paused",
            "automation.list"
        ]),
        json!(["automation.list", "automation.save", false]),
    ] {
        let mut fixture = PostverifyFixture::new(ENVIRONMENT);
        fixture.review["progress"]["health"]["requiredTools"] = tools;
        let result = fixture.verify(None);
        assert!(result.is_err());
        let mut journal = Journal::default();
        journal
            .servers
            .insert(ENVIRONMENT.into(), fixture.server.clone());
        journal.active_environment_id = Some(ENVIRONMENT.into());
        finish_verification(&mut journal, ENVIRONMENT, result).unwrap();
        assert_eq!(journal.servers[ENVIRONMENT].state, Phase::Verifying);
        assert_eq!(journal.active_environment_id.as_deref(), Some(ENVIRONMENT));
        assert!(!should_launch(
            &journal,
            ENVIRONMENT,
            Some(&fixture.review),
            0
        ));
    }
}
#[test]
fn optional_live_catalogue_cannot_contradict_root_qualification() {
    let fixture = PostverifyFixture::new(ENVIRONMENT);
    assert!(fixture.verify(None).is_ok());
    assert!(fixture.verify(Some(&json!([{"name":"automation.list"},{"name":"automation.save"},{"name":"automation.set_paused"}]))).is_ok());
    assert!(fixture.verify(Some(&json!([]))).is_err());
    assert!(fixture.verify(Some(&json!({"tools":[]}))).is_err());
}
#[test]
fn fresh_observation_must_verify_release_pins_host_auth_and_complete_service_set() {
    for (field, value) in [
        ("environmentId", json!(DEVICE)),
        ("releaseId", json!("host-bbbbbbbbbbbbbbbbbbbb")),
        ("manifest", Value::Null),
        ("runtimePinsSha256", json!("c".repeat(64))),
        ("stableSeconds", json!(7.9)),
        ("observations", json!(4)),
        ("hostAuthEnforced", json!(false)),
        ("fullControl", json!(false)),
        ("services", json!([])),
    ] {
        let mut fixture = PostverifyFixture::new(ENVIRONMENT);
        fixture.observed[field] = value;
        assert!(fixture.verify(None).is_err(), "{field}");
    }
    for (field, value) in [
        ("pid", json!(0)),
        ("restarts", json!(-1)),
        ("unit", json!("unexpected.service")),
    ] {
        let mut fixture = PostverifyFixture::new(ENVIRONMENT);
        fixture.observed["services"][0][field] = value;
        assert!(fixture.verify(None).is_err(), "{field}");
    }
    let mut fixture = PostverifyFixture::new(ENVIRONMENT);
    fixture.observed["services"][0] = fixture.observed["services"][1].clone();
    assert!(fixture.verify(None).is_err());
}
#[test]
fn taskless_verification_still_requires_bound_completion_and_authenticated_inventory() {
    for part in [
        "receipt",
        "worker",
        "coordinator",
        "historical_health",
        "signature",
    ] {
        let mut fixture = PostverifyFixture::new(ENVIRONMENT);
        match part {
            "receipt" => fixture.review["hostStatusVerified"] = json!(false),
            "worker" => fixture.inventory["manifest"] = Value::Null,
            "coordinator" => {
                fixture.environment["runtime"]["release"] = json!("host-bbbbbbbbbbbbbbbbbbbb")
            }
            "historical_health" => fixture.review["progress"]["health"]["releaseId"] = Value::Null,
            _ => {
                fixture.review["artifact"]["authorization"]["signature"] =
                    json!(STANDARD.encode([0; 64]))
            }
        }
        assert!(fixture.verify(None).is_err(), "{part}");
    }
}
#[test]
fn verification_cannot_release_another_servers_reservation() {
    let fixture = PostverifyFixture::new(ENVIRONMENT);
    let mut journal = Journal::default();
    journal
        .servers
        .insert(ENVIRONMENT.into(), fixture.server.clone());
    journal.active_environment_id = Some(DEVICE.into());
    assert!(finish_verification(&mut journal, ENVIRONMENT, fixture.verify(None)).is_err());
    assert_eq!(journal.active_environment_id.as_deref(), Some(DEVICE));
}
#[test]
fn fresh_service_probe_accepts_rebooted_pids_but_rejects_restart_within_window() {
    let script = r#"import json,sys,pathlib,stat,types,subprocess,time,urllib.request,urllib.error
from unittest.mock import patch
packet=json.load(sys.stdin)
root=pathlib.Path('/opt/outpost-native/releases/host-aaaaaaaaaaaaaaaaaaaa')
files={str(root/'host-manifest.json'):json.dumps({'id':root.name}).encode(),str(root/'deploy/environment/runtime-pins.json'):b'{}','/etc/outpost-native/installation.json':json.dumps({'environmentId':'11111111-1111-4111-8111-111111111111','release':root.name,'fullControl':True}).encode()}
clock=[0.0];calls=[0]
def resolve(path,*args,**kwargs): return root if str(path)=='/opt/outpost-native/current' else path
def read(path): return files[str(path)]
def sleep(seconds): clock[0]+=seconds
def run(args,**kwargs):
 calls[0]+=1
 assert args[0]=='/usr/bin/systemctl' and args[1]=='show'
 pid=5000+['outpost-native-worker.service','outpost-native-coordinator.service','outpost-native-host.service'].index(args[2])
 if packet['unstable'] and calls[0]>3: pid+=100
 return types.SimpleNamespace(stdout=f'ActiveState=active\nSubState=running\nMainPID={pid}\nNRestarts=0\n'.encode())
class Response:
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def read(self,limit): return b'{"ready":true,"host":"local"}'
class Opener:
 def open(self,url,**kwargs):
  if url=='http://127.0.0.1:4519/health': return Response()
  assert url=='http://127.0.0.1:4519/outpost-update-auth-probe'
  raise urllib.error.HTTPError(url,401,'Unauthorized',{},None)
with patch.object(pathlib.Path,'resolve',resolve),patch.object(pathlib.Path,'lstat',lambda _:types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o444)),patch.object(pathlib.Path,'read_bytes',read),patch.object(subprocess,'run',run),patch.object(time,'sleep',sleep),patch.object(time,'monotonic',lambda:clock[0]),patch.object(urllib.request,'build_opener',lambda *args:Opener()):
 exec(compile(packet['source'],'service-probe','exec'))
"#;
    for unstable in [false, true] {
        let input =
            serde_json::to_vec(&json!({"source":SERVICE_PROBE,"unstable":unstable})).unwrap();
        let result = run(
            "python3",
            &["-I".into(), "-c".into(), script.into()],
            &input,
            Duration::from_secs(5),
            &AtomicBool::new(false),
        );
        if unstable {
            assert!(result.is_err());
        } else {
            let observed: Value = serde_json::from_slice(&result.unwrap()).unwrap();
            assert_eq!(observed["services"][0]["pid"], 5000);
            assert_eq!(observed["services"][0]["restarts"], 0);
            assert_eq!(observed["stableSeconds"], 8.0);
            assert_eq!(observed["hostAuthEnforced"], true);
            assert_eq!(observed["runtimePinsSha256"], sha(b"{}"));
        }
    }
}
#[test]
fn taskless_verification_does_not_require_a_host_executor_when_not_configured() {
    let mut fixture = PostverifyFixture::new(ENVIRONMENT);
    fixture.observed["fullControl"] = json!(false);
    fixture.observed["hostAuthEnforced"] = json!(false);
    fixture.runtime["hostAdministration"] = json!(false);
    fixture.observed["services"].as_array_mut().unwrap().pop();
    fixture.review["progress"]["health"]["services"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert!(fixture.verify(None).is_ok());
}
fn release_for_bytes(bytes: &[u8], sequence: u64) -> Value {
    let mut release = artifact();
    let mut payload = verify_authorization(&release, None).unwrap();
    release["sha256"] = json!(sha(bytes));
    release["size"] = json!(bytes.len());
    release["manifest"]["sequence"] = json!(sequence);
    payload["sha256"] = release["sha256"].clone();
    payload["size"] = release["size"].clone();
    payload["manifest"] = release["manifest"].clone();
    resign(&mut release, payload);
    release
}
#[test]
fn replaced_app_archive_is_rechecked_before_reserving_any_operation() {
    let fixture = Fixture::new();
    let setup = Setup::new(fixture.0.clone()).unwrap();
    let (mut journal, mut review) = checked_journal();
    let old = release_for_bytes(b"old bundled release", 6);
    let replacement = release_for_bytes(b"replacement bundled release", 7);
    let pin = old["authorization"]["publisherPublicKey"].as_str().unwrap();
    review["artifact"] = old.clone();
    save(&setup, ENVIRONMENT, &review).unwrap();
    assert!(should_launch(&journal, ENVIRONMENT, Some(&review), 100));
    for (metadata, bytes) in [
        (&replacement, b"replacement bundled release".as_slice()),
        (&old, b"replacement bundled release".as_slice()),
    ] {
        let error = validate_current_release(&review, metadata, bytes, pin).unwrap_err();
        assert!(matches!(error, PreSubmissionError::Recheck(_)));
        pre_submission_failed(&mut journal, ENVIRONMENT, error).unwrap();
        journal.write(&setup.directory).unwrap();
        let restarted = Journal::read(&setup.directory).unwrap();
        assert!(restarted.active_environment_id.is_none());
        assert_eq!(restarted.servers[ENVIRONMENT].state, Phase::Ready);
        assert!(restarted.servers[ENVIRONMENT].operation_id.is_none());
        assert_eq!(load(&setup, ENVIRONMENT).unwrap(), review);
        assert!(restarted.servers[ENVIRONMENT]
            .message
            .contains("No maintenance request was submitted"));
    }
    let mut refreshed = review.clone();
    refreshed["artifact"] = replacement.clone();
    assert!(validate_current_release(
        &refreshed,
        &replacement,
        b"replacement bundled release",
        pin
    )
    .is_ok());
    let server = journal.servers.get_mut(ENVIRONMENT).unwrap();
    server.state = Phase::Checked;
    server.review_id = refreshed["reviewId"].as_str().map(String::from);
    server.operation_id = refreshed["operationId"].as_str().map(String::from);
    assert!(should_launch(&journal, ENVIRONMENT, Some(&refreshed), 100));
}
#[test]
fn preflight_failure_never_clears_an_uncertain_submission_even_with_review_receipt() {
    for phase in [Phase::Authorizing, Phase::Unknown, Phase::Updating] {
        let mut journal = journal();
        journal.hold(ENVIRONMENT, phase.clone(), "possibly submitted");
        let before = serde_json::to_value(&journal).unwrap();
        assert!(pre_submission_failed(
            &mut journal,
            ENVIRONMENT,
            PreSubmissionError::Recheck("archive changed".into())
        )
        .is_err());
        assert_eq!(serde_json::to_value(&journal).unwrap(), before);
    }
}
fn current_enrollment_policy() -> Value {
    public_policy(&policy(
        ENVIRONMENT,
        DEVICE,
        &STANDARD.encode([7; 32]),
        "operator",
    ))
}
#[test]
fn helper_upgrade_blocks_before_submission_without_an_active_latch() {
    let current = current_enrollment_policy();
    let mut old = current.clone();
    old["sourcesSha256"]["auto_update.py"] = json!("a".repeat(64));
    let message = verify_current_helper(&old, &old).unwrap_err();
    assert!(message.contains("renewed protected authorization"));
    let (mut journal, review) = checked_journal();
    journal.servers.get_mut(ENVIRONMENT).unwrap().policy = Some(old.clone());
    pre_submission_failed(
        &mut journal,
        ENVIRONMENT,
        PreSubmissionError::Blocked(message),
    )
    .unwrap();
    assert!(journal.active_environment_id.is_none());
    assert_eq!(journal.servers[ENVIRONMENT].state, Phase::Blocked);
    assert!(!should_launch(&journal, ENVIRONMENT, Some(&review), 100));
    let fixture = Fixture::new();
    journal.write(&fixture.0).unwrap();
    let restored = Journal::read(&fixture.0).unwrap();
    assert!(restored.active_environment_id.is_none());
    assert_eq!(restored.servers[ENVIRONMENT].policy, Some(old));
    assert_eq!(restored.status()["servers"][0]["state"], "blocked");
    for name in ["auto_update.py", "common.py", "host_update.py"] {
        let mut changed = current.clone();
        changed["sourcesSha256"][name] = json!("b".repeat(64));
        assert!(verify_current_helper(&current, &changed).is_err());
    }
    assert!(verify_current_helper(&current, &current).is_ok());
}
#[test]
fn renewal_requires_same_identity_and_exact_reviewed_old_policy() {
    let current = current_enrollment_policy();
    let mut old = current.clone();
    old["sourcesSha256"]["host_update.py"] = json!("c".repeat(64));
    assert_eq!(
        enrollment_action(Some(&old), &old, &current).unwrap(),
        EnrollmentAction::Renew(old.clone())
    );
    assert_eq!(
        enrollment_action(None, &Value::Null, &current).unwrap(),
        EnrollmentAction::Fresh
    );
    assert_eq!(
        enrollment_action(Some(&current), &current, &current).unwrap(),
        EnrollmentAction::Existing
    );
    assert_eq!(
        enrollment_action(Some(&old), &current, &current).unwrap(),
        EnrollmentAction::Existing
    );
    assert!(enrollment_action(Some(&old), &Value::Null, &current).is_err());
    for (field, value) in [
        ("environmentId", json!(OPERATION)),
        ("deviceId", json!(OPERATION)),
        ("publisherPublicKey", json!(STANDARD.encode([9; 32]))),
        ("sshUser", json!("another")),
    ] {
        let mut changed = old.clone();
        changed[field] = value;
        assert!(enrollment_action(Some(&old), &changed, &current).is_err());
        assert!(enrollment_action(Some(&changed), &old, &current).is_err());
    }
    let mut unexpected = old.clone();
    unexpected["sourcesSha256"]["auto_update.py"] = json!("d".repeat(64));
    assert!(enrollment_action(Some(&old), &unexpected, &current).is_err());
}
#[test]
fn renewal_bootstrap_binds_exact_old_policy_without_invoking_the_update_helper() {
    let current = current_enrollment_policy();
    let identity = policy_identity(&current).unwrap();
    let mut old = current.clone();
    old["sourcesSha256"]["host_update.py"] = json!("f".repeat(64));
    let source = enrollment_source(&identity, Some(&old), Some(OPERATION)).unwrap();
    assert!(source.contains(
        ".reauthorize(p,previous,raw['auto_update'],raw['host_update'],raw['common'])"
    ));
    assert!(!source.contains(".enroll(p,"));
    assert!(!source.contains(LAUNCH));
    let packet = json!({"source":renewal_action(&identity, &old, OPERATION).unwrap(),"identity":identity,"previous":old,"desired":current,"attemptId":OPERATION});
    // Execute only the native receipt wrapper against a synchronous fake helper.
    // No bundled module, privileged command, keychain or network is executed.
    let script = r#"import base64,contextlib,copy,io,json,pathlib,sys,tempfile,types
packet=json.load(sys.stdin)
results={}
class Interrupted(BaseException): pass
for mode in ['success','before','after','killed','corrupt']:
 with tempfile.TemporaryDirectory() as directory:
  events=[]; receipts=[]; inside=[False]; calls=[]
  def require(condition):
   if not condition: raise ValueError('Refused')
  def atomic_json(path,value,permissions):
   assert path==pathlib.Path(directory)/'auto-update-native-renewal.json' and permissions==0o644
   if value['state']!='running': assert not inside[0] and events[-1]=='returned'
   receipts.append(copy.deepcopy(value))
  def reauthorize(policy,previous,helper,updater,common):
   assert policy==packet['identity'] and previous==packet['previous']
   assert (helper,updater,common)==(b'helper',b'updater',b'common')
   assert receipts[-1]['state']=='running' and receipts[-1]['attemptId']==packet['attemptId']
   calls.append(previous); inside[0]=True
   try:
    if mode=='killed': raise Interrupted()
    if mode!='success': raise ValueError('Synthetic terminal refusal')
    return packet['desired']
   finally:
    inside[0]=False; events.append('returned')
  def verify_sources(root,policy,**kwargs):
   assert policy==packet['previous']
   if mode=='corrupt': raise ValueError('Corrupt previous helper')
  helper=types.SimpleNamespace(CONFIG=pathlib.Path(directory),os=types.SimpleNamespace(geteuid=lambda:0),require=require,validate_public_policy=lambda p,**k:require(p in [packet['previous'],packet['desired']]),secure_path=lambda *a,**k:None,atomic_json=atomic_json,reauthorize=reauthorize,read_public=lambda p:packet['desired'] if mode=='after' else packet['previous'],active_library=lambda p,**k:pathlib.Path(directory),verify_sources=verify_sources)
  fake=types.SimpleNamespace(modules={'auto_update':helper})
  namespace={'base64':base64,'json':json,'sys':fake,'p':packet['identity'],'raw':{'auto_update':b'helper','common':b'common','host_update':b'updater'}}
  try:
   with contextlib.redirect_stdout(io.StringIO()): exec(packet['source'],namespace)
   assert mode=='success'
  except (ValueError,Interrupted):
   assert mode!='success'
  assert len(calls)==1
  assert len(receipts)==(1 if mode=='killed' else 2)
  results[mode]=receipts[-1]
print(json.dumps(results))
"#;
    let bytes = run(
        "python3",
        &["-I".into(), "-c".into(), script.into()],
        &serde_json::to_vec(&packet).unwrap(),
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .unwrap();
    let receipts: Value = serde_json::from_slice(&bytes).unwrap();
    let (journal, _, _) = pending_renewal();
    for (mode, state) in [
        ("success", "complete"),
        ("before", "previous_retained"),
        ("after", "unknown"),
        ("killed", "running"),
        ("corrupt", "unknown"),
    ] {
        assert_eq!(receipts[mode]["state"], state);
        assert_eq!(
            terminal_previous_renewal(&journal.servers[ENVIRONMENT], &old, &receipts[mode]),
            mode == "before"
        );
    }
    let mut foreign = old.clone();
    foreign["deviceId"] = json!(OPERATION);
    assert!(enrollment_source(&identity, Some(&foreign), Some(OPERATION)).is_err());
    assert!(enrollment_source(&identity, Some(&old), None).is_err());
    assert!(enrollment_source(&identity, None, Some(OPERATION)).is_err());
}
#[test]
fn renewal_journal_retains_both_policies_for_inspect_only_recovery() {
    let fixture = Fixture::new();
    let mut journal = journal();
    let current = current_enrollment_policy();
    let mut previous = current.clone();
    previous["sourcesSha256"]["host_update.py"] = json!("e".repeat(64));
    let server = journal.servers.get_mut(ENVIRONMENT).unwrap();
    server.policy = Some(current.clone());
    server.previous_policy = Some(previous.clone());
    journal.hold(
        ENVIRONMENT,
        Phase::Enrolling,
        "Renewal submitted; inspect only",
    );
    journal.write(&fixture.0).unwrap();
    let restored = Journal::read(&fixture.0).unwrap();
    assert_eq!(restored.active_environment_id.as_deref(), Some(ENVIRONMENT));
    assert_eq!(restored.servers[ENVIRONMENT].policy, Some(current));
    assert_eq!(
        restored.servers[ENVIRONMENT].previous_policy,
        Some(previous)
    );
    assert!(restored.status()["servers"][0]
        .get("previousPolicy")
        .is_none());
    let mut old_journal = serde_json::to_value(journal).unwrap();
    old_journal["servers"][ENVIRONMENT]
        .as_object_mut()
        .unwrap()
        .remove("previousPolicy");
    let compatible: Journal = serde_json::from_value(old_journal).unwrap();
    assert!(compatible.servers[ENVIRONMENT].previous_policy.is_none());
}
#[test]
fn public_policy_probe_reads_legacy_and_versioned_layouts_without_executing_helpers() {
    let script = r#"import ast,contextlib,hashlib,io,json,pathlib,subprocess,sys,tempfile,types
source=json.load(sys.stdin)['source']
class FixtureSecure(ast.NodeTransformer):
 def visit_FunctionDef(self,node):
  if node.name=='secure': node.body=[ast.Pass()]
  return node
def list_grant(args,**kwargs):
 assert args==['/usr/bin/sudo','-n','-l','--','/usr/local/libexec/outpost-update']
 assert kwargs['timeout']==5
 return types.SimpleNamespace(returncode=0)
subprocess.run=list_grant
for versioned,tampered,legacy_modules in [(False,False,True),(True,False,False),(True,False,True),(True,True,False)]:
 with tempfile.TemporaryDirectory() as directory:
  root=pathlib.Path(directory); config=root/'config'; library=root/'library'; executable=root/'bin'
  for p in [config,library,executable]: p.mkdir()
  names=['auto_update.py','host_install.py','host_update.py'] if legacy_modules else ['auto_update.py','common.py','host_update.py']
  modules={name:('fixture '+name).encode() for name in names}
  policy={'schema':1,'environmentId':'fixture','deviceId':'fixture','publisherPublicKey':'fixture','sshUser':'operator','sourcesSha256':{name:hashlib.sha256(data).hexdigest() for name,data in modules.items()}}
  selected=library
  if versioned:
   version=hashlib.sha256(json.dumps(policy['sourcesSha256'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
   selected=library/'versions'/version; selected.mkdir(parents=True)
  for name,data in modules.items(): (selected/name).write_bytes(data)
  if tampered: (selected/'host_update.py').write_bytes(b'changed')
  (config/'auto-update.json').write_text(json.dumps(policy))
  prefix=source.split('import json,pathlib,hashlib,stat,subprocess')[0]
  namespace={}; exec(prefix,namespace)
  (executable/'outpost-update').write_bytes(namespace['trusted_launchers'][1 if versioned else 0])
  fixture=source.replace('/etc/outpost-native',str(config)).replace('/usr/local/lib/outpost-updater',str(library)).replace("pathlib.Path('/usr/local/libexec/outpost-update')",'pathlib.Path('+repr(str(executable/'outpost-update'))+')')
  tree=ast.fix_missing_locations(FixtureSecure().visit(ast.parse(fixture)))
  try:
   output=io.StringIO()
   with contextlib.redirect_stdout(output): exec(compile(tree,'fixture','exec'),{})
   assert not tampered and json.loads(output.getvalue())==policy
  except ValueError:
   assert tampered
print('policy layouts verified')
"#;
    let packet = json!({"source":policy_probe_source().unwrap()});
    let output = run(
        "python3",
        &["-I".into(), "-c".into(), script.into()],
        &serde_json::to_vec(&packet).unwrap(),
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(output, b"policy layouts verified\n");
}
fn pending_renewal() -> (Journal, Value, Value) {
    let mut journal = journal();
    let desired = current_enrollment_policy();
    let mut previous = desired.clone();
    previous["sourcesSha256"]["host_update.py"] = json!("f".repeat(64));
    let server = journal.servers.get_mut(ENVIRONMENT).unwrap();
    server.policy = Some(desired.clone());
    server.previous_policy = Some(previous.clone());
    server.enrollment_attempt_id = Some(OPERATION.into());
    journal.hold(ENVIRONMENT, Phase::Enrolling, "Renewal outcome uncertain");
    (journal, previous, desired)
}
#[test]
fn terminal_renewal_receipt_requires_exact_attempt_identity_policies_and_state() {
    let (journal, previous, desired) = pending_renewal();
    let server = &journal.servers[ENVIRONMENT];
    let receipt = json!({"schema":1,"attemptId":OPERATION,"environmentId":ENVIRONMENT,"previousPolicy":previous,"desiredPolicy":desired,"state":"previous_retained"});
    assert!(terminal_previous_renewal(server, &previous, &receipt));
    for field in [
        "schema",
        "attemptId",
        "environmentId",
        "previousPolicy",
        "desiredPolicy",
        "state",
    ] {
        let mut changed = receipt.clone();
        changed[field] = Value::Null;
        assert!(
            !terminal_previous_renewal(server, &previous, &changed),
            "{field}"
        );
    }
    for state in ["running", "unknown", "complete", "failed", "cancelled"] {
        let mut changed = receipt.clone();
        changed["state"] = json!(state);
        assert!(!terminal_previous_renewal(server, &previous, &changed));
    }
    let mut stale = receipt.clone();
    stale["attemptId"] = json!(DEVICE);
    assert!(!terminal_previous_renewal(server, &previous, &stale));
    let mut unknown = receipt.clone();
    unknown["unreviewed"] = json!(true);
    assert!(!terminal_previous_renewal(server, &previous, &unknown));
    assert!(!terminal_previous_renewal(server, &desired, &receipt));
    let mut legacy = server.clone();
    legacy.enrollment_attempt_id = None;
    assert!(!terminal_previous_renewal(&legacy, &previous, &receipt));
    let mut foreign = server.clone();
    foreign.environment_id = DEVICE.into();
    assert!(!terminal_previous_renewal(&foreign, &previous, &receipt));
    let fixture = Fixture::new();
    journal.write(&fixture.0).unwrap();
    let restored = Journal::read(&fixture.0).unwrap();
    assert!(terminal_previous_renewal(
        &restored.servers[ENVIRONMENT],
        &previous,
        &receipt
    ));
}
#[test]
fn terminal_previous_policy_releases_only_enrollment_latch_and_requires_new_consent() {
    let fixture = Fixture::new();
    let (mut journal, previous, _) = pending_renewal();
    journal.write(&fixture.0).unwrap();
    let mut restored = Journal::read(&fixture.0).unwrap();
    finish_enrollment_observation(&mut restored, ENVIRONMENT, &previous, true).unwrap();
    assert!(restored.active_environment_id.is_none());
    assert!(!restored.enabled);
    assert_eq!(restored.servers[ENVIRONMENT].state, Phase::Blocked);
    assert_eq!(restored.servers[ENVIRONMENT].policy, Some(previous));
    assert!(restored.servers[ENVIRONMENT].previous_policy.is_none());
    assert!(restored.servers[ENVIRONMENT]
        .enrollment_attempt_id
        .is_none());
    assert!(restored.servers[ENVIRONMENT]
        .message
        .contains("new protected authorization"));
    restored.write(&fixture.0).unwrap();
    let restarted = Journal::read(&fixture.0).unwrap();
    assert!(restarted.active_environment_id.is_none());
    assert!(!restarted.enabled);
    assert_eq!(restarted.status()["servers"][0]["state"], "not_enabled");
    journal.enabled = false;
    assert!(journal.active_environment_id.is_some());
}
#[test]
fn old_policy_without_terminal_evidence_does_not_release_or_retry_renewal() {
    let (mut journal, previous, _) = pending_renewal();
    let before = serde_json::to_value(&journal).unwrap();
    finish_enrollment_observation(&mut journal, ENVIRONMENT, &previous, false).unwrap();
    assert_eq!(serde_json::to_value(&journal).unwrap(), before);
    finish_enrollment_observation(&mut journal, ENVIRONMENT, &Value::Null, true).unwrap();
    assert_eq!(serde_json::to_value(&journal).unwrap(), before);
    let mut foreign = previous.clone();
    foreign["environmentId"] = json!(DEVICE);
    finish_enrollment_observation(&mut journal, ENVIRONMENT, &foreign, true).unwrap();
    assert_eq!(serde_json::to_value(&journal).unwrap(), before);
    assert!(finish_enrollment_observation(&mut journal, DEVICE, &previous, true).is_err());
    journal.servers.get_mut(ENVIRONMENT).unwrap().state = Phase::Unknown;
    assert!(finish_enrollment_observation(&mut journal, ENVIRONMENT, &previous, true).is_err());
}
#[test]
fn completed_policy_reconciliation_keeps_existing_inspect_only_success_path() {
    let (mut journal, _, desired) = pending_renewal();
    journal.enabled = false;
    finish_enrollment_observation(&mut journal, ENVIRONMENT, &desired, false).unwrap();
    assert!(journal.active_environment_id.is_none());
    assert_eq!(journal.servers[ENVIRONMENT].state, Phase::Ready);
    assert_eq!(journal.servers[ENVIRONMENT].policy, Some(desired));
    assert!(journal.servers[ENVIRONMENT].previous_policy.is_none());
    assert!(!journal.enabled);
}
#[test]
fn embedded_python_compiles_without_executing_network_or_privileged_work() {
    let source = enrollment_source(
        &policy(ENVIRONMENT, DEVICE, &STANDARD.encode([7; 32]), "operator"),
        None,
        None,
    )
    .unwrap();
    let renewal = enrollment_source(
        &policy_identity(&current_enrollment_policy()).unwrap(),
        Some(&current_enrollment_policy()),
        Some(OPERATION),
    )
    .unwrap();
    let probe = policy_probe_source().unwrap();
    assert!(isolated_python(&probe).len() < 131072);
    let recovery = enrollment_inspection_source().unwrap();
    assert!(isolated_python(&recovery).len() < 131072);
    let packet = json!([probe, recovery, SERVICE_PROBE, source, renewal, HELPER]);
    let script = "import ast,json,sys\nfor source in json.load(sys.stdin):\n ast.parse(source)\n";
    let mut child = Command::new("python3")
        .args(["-I", "-c", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&packet).unwrap())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn postverify_tools_queries_tools_directly_without_snapshot() {
    use std::io::{Read, Write};
    tauri::async_runtime::block_on(async {
        for (status, reply, expected_some) in [
            (
                "200 OK",
                json!([{"name":"automation.list"},{"name":"automation.save"},{"name":"automation.set_paused"}]),
                true,
            ),
            (
                "400 Bad Request",
                json!({"error":"invalid_request","message":"taskId required"}),
                false,
            ),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let status = status.to_string();
            let reply_text = reply.to_string();
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
                let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                let body: Value =
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
                write!(
                    socket,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply_text}",
                    reply_text.len()
                )
                .unwrap();
                (headers, body)
            });

            let fixture = Fixture::new();
            let state = crate::transport::State::new(fixture.0.clone()).unwrap();
            {
                let mut client = state.client.lock().unwrap();
                client.endpoint = endpoint;
                client.identity = Some(crate::transport::Identity {
                    id: DEVICE.into(),
                    key: SigningKey::from_bytes(&[7; 32]),
                });
            }

            let tools = fetch_postverify_tools(&state).await;
            if expected_some {
                assert_eq!(tools, Some(reply));
            } else {
                assert!(tools.is_none());
            }
            let (headers, body) = server.join().unwrap();
            assert!(headers.starts_with("POST /v1/query HTTP/1.1"));
            assert_eq!(body["type"], "tools");
            assert_eq!(body["payload"], json!({}));
        }
    });
}

#[test]
fn service_probe_reads_configured_host_port_from_host_env() {
    let script = r#"import json,sys,pathlib,stat,types,subprocess,time,urllib.request,urllib.error
from unittest.mock import patch
packet=json.load(sys.stdin)
root=pathlib.Path('/opt/outpost-native/releases/host-aaaaaaaaaaaaaaaaaaaa')
files={str(root/'host-manifest.json'):json.dumps({'id':root.name}).encode(),str(root/'deploy/environment/runtime-pins.json'):b'{}','/etc/outpost-native/installation.json':json.dumps({'environmentId':'11111111-1111-4111-8111-111111111111','release':root.name,'fullControl':True}).encode()}
if packet['hostEnv'] is not None:
 files['/etc/outpost-native/host.env']=packet['hostEnv'].encode()
clock=[0.0];urls=[]
def resolve(path,*args,**kwargs): return root if str(path)=='/opt/outpost-native/current' else path
def read(path):
 if str(path)=='/etc/outpost-native/host.env' and packet['denyHostEnv']:
  raise PermissionError('root only')
 return files[str(path)]
def sleep(seconds): clock[0]+=seconds
def run(args,**kwargs):
 pid=5000+['outpost-native-worker.service','outpost-native-coordinator.service','outpost-native-host.service'].index(args[2])
 return types.SimpleNamespace(stdout=f'ActiveState=active\nSubState=running\nMainPID={pid}\nNRestarts=0\n'.encode())
class Response:
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def read(self,limit): return b'{"ready":true,"host":"local"}'
class Opener:
 def open(self,url,**kwargs):
  urls.append(url)
  if url.endswith('/health'): return Response()
  raise urllib.error.HTTPError(url,401,'Unauthorized',{},None)
with patch.object(pathlib.Path,'resolve',resolve),patch.object(pathlib.Path,'lstat',lambda _:types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o600)),patch.object(pathlib.Path,'read_bytes',read),patch.object(subprocess,'run',run),patch.object(time,'sleep',sleep),patch.object(time,'monotonic',lambda:clock[0]),patch.object(urllib.request,'build_opener',lambda *args:Opener()):
 exec(compile(packet['source'],'service-probe','exec'))
assert urls==[f"http://127.0.0.1:{packet['expectedPort']}/health",f"http://127.0.0.1:{packet['expectedPort']}/outpost-update-auth-probe"], urls
"#;
    for (host_env, deny, expected_port) in [
        (Some("# comment\nOUTPOST_HOST_PORT=\"5519\"\n"), false, 5519),
        (Some("OUTPOST_HOST_PORT='5520'\n"), false, 5520),
        (Some("OUTPOST_HOST_PORT=99999\n"), false, 4519),
        (Some("OUTPOST_HOST_PORT=5519\n"), true, 4519),
        (None, false, 4519),
    ] {
        let input = serde_json::to_vec(&json!({
            "source": SERVICE_PROBE,
            "hostEnv": host_env,
            "denyHostEnv": deny,
            "expectedPort": expected_port
        }))
        .unwrap();
        let output = run(
            "python3",
            &["-I".into(), "-c".into(), script.into()],
            &input,
            Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .unwrap();
        let observed: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(observed["hostAuthEnforced"], true);
    }
}
#[test]
fn legacy_host_install_policy_blocks_updates_and_offers_renewal() {
    let current = current_enrollment_policy();
    let mut legacy = current.clone();
    legacy["sourcesSha256"] = json!({
        "auto_update.py": "a".repeat(64),
        "host_install.py": "b".repeat(64),
        "host_update.py": "c".repeat(64),
    });
    assert_eq!(
        verify_current_helper(&legacy, &legacy).unwrap_err(),
        RENEW_HELPER
    );
    assert_eq!(
        enrollment_action(Some(&legacy), &legacy, &current).unwrap(),
        EnrollmentAction::Renew(legacy.clone())
    );
    assert_eq!(
        enrollment_action(None, &legacy, &current).unwrap(),
        EnrollmentAction::Renew(legacy)
    );
}

#[cfg(unix)]
#[test]
fn recover_host_inspection_invokes_setup_ssh_program_fixture() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let mut setup = Setup::new(fixture.0.clone()).unwrap();
    let mut key = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
    key.extend([9; 32]);
    let (key, fingerprint) =
        parse_key(&format!("fixture ssh-ed25519 {}", STANDARD.encode(key))).unwrap();
    let setup_id = Uuid::new_v4().to_string();
    setup.inner.lock().unwrap().challenges.insert(
        setup_id.clone(),
        Challenge {
            scan: Scan {
                id: setup_id.clone(),
                target: Target {
                    host: "fixture.example".into(),
                    user: "fixture".into(),
                    port: 22,
                    identity_file: None,
                },
                fingerprint: fingerprint.clone(),
            },
            key,
            created: Instant::now(),
        },
    );
    let entry = setup
        .trust(setup_id, fingerprint, "Recovery fixture".into())
        .unwrap();
    let marker = fixture.0.join("ssh-invoked.json");
    let script = fixture.0.join("ssh-fixture");
    let expected_release = "host-aaaaaaaaaaaaaaaaaaaa";
    let digest = "b".repeat(64);
    fs::write(
        &script,
        format!(
            r#"#!/usr/bin/python3
import json, pathlib, sys
pathlib.Path({marker:?}).write_text(json.dumps(sys.argv))
print(json.dumps({{
    'environmentId': {ENVIRONMENT:?},
    'operationId': {OPERATION:?},
    'failureStage': 'staging',
    'expectedRelease': {expected_release:?},
    'sha256': {digest:?},
    'state': 'safe_to_recheck',
    'updaterState': 'inactive',
}}))
"#
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    setup.ssh_fixture = Some(script.display().to_string());

    let observed = inspect_failed_host_over_ssh(
        &setup,
        &entry,
        ENVIRONMENT,
        OPERATION,
        expected_release,
        &digest,
        false,
    )
    .unwrap();
    assert_eq!(observed["state"], "safe_to_recheck");
    assert_eq!(observed["failureStage"], "staging");
    let argv: Vec<String> = serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
    assert!(argv.iter().any(|arg| arg == "fixture.example"));
    assert!(argv
        .last()
        .is_some_and(|cmd| cmd.contains("sudo -n -- /usr/bin/python3 -I -c")));
    // Verify the production recovery function has no hardcoded /usr/bin/ssh literal.
    assert!(
        !include_str!("server_auto_update.rs").contains(r#"run("/usr/bin/ssh""#),
        "server_auto_update.rs must use setup.ssh_program() instead of hardcoded /usr/bin/ssh"
    );
}

#[test]
fn partial_subset_enrollment_and_per_server_disable_preserve_unselected_and_remaining_targets() {
    let saved = vec![ENVIRONMENT.to_string(), DEVICE.to_string()];
    // Selecting a single server succeeds without requiring all saved servers.
    let subset = resolve_enrollment_targets(&saved, vec![ENVIRONMENT.into()]).unwrap();
    assert_eq!(subset, vec![ENVIRONMENT.to_string()]);
    assert!(resolve_enrollment_targets(&saved, vec![OPERATION.into()]).is_err());
    assert!(resolve_enrollment_targets(&saved, vec![ENVIRONMENT.into(), ENVIRONMENT.into()]).is_err());

    let mut journal = Journal::default();
    // Complete enrollment for ENVIRONMENT only; DEVICE stays unselected.
    let env_policy = public_policy(&policy(
        ENVIRONMENT,
        DEVICE,
        &STANDARD.encode([7; 32]),
        "operator",
    ));
    let mut server_a = Server::new(ENVIRONMENT.into());
    server_a.policy = Some(env_policy);
    server_a.state = Phase::Checked;
    server_a.operation_id = Some(OPERATION.into());
    server_a.review_id = Some(DEVICE.into());
    server_a.release_id = Some("host-aaaaaaaaaaaaaaaaaaaa".into());
    journal.servers.insert(ENVIRONMENT.into(), server_a);
    merge_enrollment_targets(&mut journal, &saved, &subset);
    assert!(journal.enabled);
    assert_eq!(journal.targets, vec![ENVIRONMENT.to_string()]);
    assert!(journal.servers.contains_key(ENVIRONMENT));
    assert!(!journal.servers.contains_key(DEVICE));

    let mut review_a = receipt("review");
    review_a["available"] = json!(true);
    review_a["reviewId"] = json!(DEVICE);
    review_a["expiresAt"] = json!(1000);
    assert!(should_launch(&journal, ENVIRONMENT, Some(&review_a), 100));
    let mut review_b = review_a.clone();
    review_b["environmentId"] = json!(DEVICE);
    assert!(!should_launch(&journal, DEVICE, Some(&review_b), 100));

    // Interrupted enrollment of DEVICE holds the queue via Phase::Enrolling without
    // disabling already-enrolled ENVIRONMENT or prematurely adding DEVICE to targets.
    let mut enrolling_b = Server::new(DEVICE.into());
    enrolling_b.policy = Some(public_policy(&policy(
        DEVICE,
        DEVICE,
        &STANDARD.encode([7; 32]),
        "operator",
    )));
    journal.servers.insert(DEVICE.into(), enrolling_b);
    journal.hold(DEVICE, Phase::Enrolling, "Enrollment reserved");
    assert!(journal.validate().is_ok());
    assert!(journal.enabled);
    assert_eq!(journal.targets, vec![ENVIRONMENT.to_string()]);
    assert!(!should_launch(&journal, ENVIRONMENT, Some(&review_a), 100));
    assert_eq!(
        journal.status()["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["environmentId"] == DEVICE)
            .unwrap()["state"],
        "enrolling"
    );

    // Completing enrollment of DEVICE preserves already-enrolled ENVIRONMENT in targets.
    journal.active_environment_id = None;
    journal.servers.get_mut(DEVICE).unwrap().state = Phase::Ready;
    let second = resolve_enrollment_targets(&saved, vec![DEVICE.into()]).unwrap();
    merge_enrollment_targets(&mut journal, &saved, &second);
    assert!(journal.enabled);
    assert_eq!(journal.targets, vec![ENVIRONMENT.to_string(), DEVICE.to_string()]);

    // Disabling ENVIRONMENT leaves DEVICE enabled; disabling DEVICE turns enabled off.
    disable_targets(&mut journal, Some(ENVIRONMENT)).unwrap();
    assert!(journal.enabled);
    assert_eq!(journal.targets, vec![DEVICE.to_string()]);
    assert_eq!(journal.status()["servers"].as_array().unwrap().len(), 2);
    disable_targets(&mut journal, Some(DEVICE)).unwrap();
    assert!(!journal.enabled);
    assert!(journal.targets.is_empty());

    // Re-enabling only ENVIRONMENT after a global disable does not silently re-enable DEVICE.
    merge_enrollment_targets(&mut journal, &saved, &subset);
    assert!(journal.enabled);
    assert_eq!(journal.targets, vec![ENVIRONMENT.to_string()]);
}
