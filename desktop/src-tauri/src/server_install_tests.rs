use super::*;

pub(super) fn fixture() -> (PathBuf, Setup, Entry, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("outpost-install-test-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut setup = Setup::new(root.clone()).unwrap();
    let mut key = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
    key.extend([8; 32]);
    let (key, fingerprint) =
        parse_key(&format!("fixture ssh-ed25519 {}", STANDARD.encode(key))).unwrap();
    let id = Uuid::new_v4().to_string();
    setup.inner.lock().unwrap().challenges.insert(
        id.clone(),
        Challenge {
            scan: Scan {
                id: id.clone(),
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
    let mut entry = setup
        .trust(id, fingerprint, "Test installation".into())
        .unwrap();
    let archive = root.join("release.tar.gz");
    fs::write(&archive, b"synthetic-release").unwrap();
    let sha = Sha256::digest(b"synthetic-release")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    entry.plan = Some(InstallPlan {
        plan_id: Uuid::new_v4().to_string(),
        operation_id: Uuid::new_v4().to_string(),
        environment_id: Uuid::new_v4().to_string(),
        release_id: format!("host-{}", "a".repeat(20)),
        sha256: sha,
        size: 17,
        expires_at: now() + 300000,
        browser: false,
        full_control: true,
        coexistence_required: true,
        device_id: Uuid::new_v4().to_string(),
        public_key: STANDARD.encode([7; 32]),
        node_version: "24.22.1".into(),
    });
    setup
        .inner
        .lock()
        .unwrap()
        .entries
        .insert(entry.id.clone(), entry.clone());
    let script = root.join("ssh-fixture");
    fs::write(&script, r#"#!/usr/bin/python3
import json, sys, pathlib, hashlib
receipt = pathlib.Path(__file__).with_name('receipt.json')
if sys.argv[-1].endswith('--bootstrap'):
    packet = json.loads(sys.stdin.buffer.readline())
    payload = sys.stdin.buffer.read()
    assert hashlib.sha256(payload).hexdigest() == packet['sha256']
    assert 'sudo -n -- ' in sys.argv[-1]
    assert packet['fullControl'] is True
    value = dict(operationId=packet['operationId'], environmentId=packet['environmentId'], releaseId=packet['releaseId'], state='ready', completedSteps=10, totalSteps=12, stage='Private connection', startedAt=1, updatedAt=2, log=['Fixture ready'], error=None)
    receipt.write_text(json.dumps(value))
print(receipt.read_text())
"#).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    setup.ssh_fixture = Some(script.display().to_string());
    (root, setup, entry, archive)
}
#[test]
fn installation_requires_bound_plan_separate_approval_and_coexistence_consent() {
    let (root, setup, entry, archive) = fixture();
    let plan = entry.plan.as_ref().unwrap();
    let device = (plan.device_id.clone(), plan.public_key.clone());
    for (plan_id, approved, coexistence) in [
        (&plan.plan_id, false, true),
        (&plan.plan_id, true, false),
        (&Uuid::new_v4().to_string(), true, true),
    ] {
        assert!(setup
            .start_install(
                &entry.id,
                plan_id,
                approved,
                coexistence,
                false,
                archive.clone(),
                device.clone()
            )
            .is_err());
        assert!(setup.entry(&entry.id).unwrap().installation.is_none());
    }
    assert!(!root.join("receipt.json").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn installation_verifies_bundle_and_identity_before_any_launch() {
    let (root, setup, entry, archive) = fixture();
    let plan = entry.plan.as_ref().unwrap();
    assert!(setup
        .start_install(
            &entry.id,
            &plan.plan_id,
            true,
            true,
            false,
            archive.clone(),
            (Uuid::new_v4().to_string(), plan.public_key.clone())
        )
        .is_err());
    fs::write(&archive, b"different-release").unwrap();
    assert!(setup
        .start_install(
            &entry.id,
            &plan.plan_id,
            true,
            true,
            false,
            archive,
            (plan.device_id.clone(), plan.public_key.clone())
        )
        .unwrap_err()
        .contains("checksum"));
    assert!(!root.join("receipt.json").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn durable_remote_receipt_survives_reopen_without_reinstall_or_false_completion() {
    let (root, setup, entry, archive) = fixture();
    let plan = entry.plan.as_ref().unwrap();
    let started = setup
        .start_install(
            &entry.id,
            &plan.plan_id,
            true,
            true,
            false,
            archive.clone(),
            (plan.device_id.clone(), plan.public_key.clone()),
        )
        .unwrap();
    let progress = started.installation.unwrap();
    assert_eq!(progress.completed_steps, 10);
    assert_eq!(progress.state, "ready");
    assert!(setup
        .start_install(
            &entry.id,
            &plan.plan_id,
            true,
            true,
            false,
            archive,
            (plan.device_id.clone(), plan.public_key.clone())
        )
        .is_err());
    let status = setup.install_status(&entry.id, false).unwrap();
    assert_eq!(
        status.installation.unwrap().environment_id,
        plan.environment_id
    );
    let reopened = Setup::new(root.clone()).unwrap();
    assert_eq!(
        reopened
            .entry(&entry.id)
            .unwrap()
            .installation
            .unwrap()
            .completed_steps,
        10
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn old_plans_never_silently_gain_full_server_control() {
    let (root, _, entry, _) = fixture();
    let mut value = serde_json::to_value(entry.plan.unwrap()).unwrap();
    assert_eq!(value["fullControl"], true);
    value.as_object_mut().unwrap().remove("fullControl");
    let old: InstallPlan = serde_json::from_value(value).unwrap();
    assert!(!old.full_control);
    old.validate().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn forged_completion_or_another_operation_cannot_advance_progress() {
    let (root, _, entry, _) = fixture();
    let plan = entry.plan.as_ref().unwrap();
    let mut progress = InstallProgress {
        operation_id: plan.operation_id.clone(),
        environment_id: plan.environment_id.clone(),
        release_id: plan.release_id.clone(),
        state: "ready".into(),
        completed_steps: 10,
        total_steps: 12,
        stage: "Server ready".into(),
        started_at: 1,
        updated_at: 2,
        log: vec![],
        error: None,
        remote_updated_at: None,
    };
    validate_progress(plan, &progress).unwrap();
    let upgraded = Environment {
        environment_id: plan.environment_id.clone(),
        release: Some("host-updated-release".into()),
    };
    assert!(!connection_identity_matches(&progress, &upgraded));
    let mut completed = progress.clone();
    completed.state = "complete".into();
    assert!(connection_identity_matches(&completed, &upgraded));
    let wrong_host = Environment {
        environment_id: Uuid::new_v4().to_string(),
        release: Some(plan.release_id.clone()),
    };
    assert!(!connection_identity_matches(&completed, &wrong_host));
    progress.completed_steps = 12;
    assert!(validate_progress(plan, &progress).is_err());
    progress.completed_steps = 10;
    progress.environment_id = Uuid::new_v4().to_string();
    assert!(validate_progress(plan, &progress).is_err());
    fs::remove_dir_all(root).unwrap();
}

fn receipt(entry: &Entry, state: &str, completed_steps: u8, updated_at: u64) -> InstallProgress {
    let plan = entry.plan.as_ref().unwrap();
    InstallProgress {
        operation_id: plan.operation_id.clone(),
        environment_id: plan.environment_id.clone(),
        release_id: plan.release_id.clone(),
        state: state.into(),
        completed_steps,
        total_steps: 12,
        stage: format!("Fixture {state} at {completed_steps}"),
        started_at: 1,
        updated_at,
        log: vec![format!("Fixture {state} at {updated_at}")],
        error: matches!(state, "unknown" | "failed" | "cancelled" | "interrupted")
            .then(|| format!("Fixture {state}")),
        remote_updated_at: None,
    }
}

fn assert_same_entry(actual: &Entry, expected: &Entry) {
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
}

fn assert_ignored(
    setup: &Setup,
    expected: &Entry,
    progress: InstallProgress,
    source: InstallProgressSource,
) {
    let journal = fs::read(setup.directory.join("entries.json")).unwrap();
    let actual = setup.store_install(&expected.id, progress, source).unwrap();
    let stored = setup.entry(&expected.id).unwrap();
    for entry in [&actual, &stored] {
        assert_same_entry(entry, expected);
        assert_eq!(
            entry.installation.as_ref().map(|p| p.remote_updated_at),
            expected.installation.as_ref().map(|p| p.remote_updated_at)
        );
    }
    assert_eq!(
        fs::read(setup.directory.join("entries.json")).unwrap(),
        journal
    );
}

#[test]
fn interleaved_install_receipts_are_entry_scoped_and_monotonic() {
    let (root, setup, first, _) = fixture();
    let mut second = first.clone();
    second.id = Uuid::new_v4().to_string();
    let plan = second.plan.as_mut().unwrap();
    plan.plan_id = Uuid::new_v4().to_string();
    plan.operation_id = Uuid::new_v4().to_string();
    plan.environment_id = Uuid::new_v4().to_string();
    plan.release_id = format!("host-{}", "b".repeat(20));
    setup
        .inner
        .lock()
        .unwrap()
        .entries
        .insert(second.id.clone(), second.clone());
    for (entry, steps, time) in [(&first, 3, 500), (&second, 1, 50), (&first, 6, 700)] {
        setup
            .store_install(
                &entry.id,
                receipt(entry, "running", steps, time),
                InstallProgressSource::Remote,
            )
            .unwrap();
    }
    let latest_first = setup.entry(&first.id).unwrap();
    let latest_second = setup
        .store_install(
            &second.id,
            receipt(&second, "running", 2, 70),
            InstallProgressSource::Remote,
        )
        .unwrap();
    assert!(setup
        .store_install(
            &second.id,
            receipt(&first, "running", 7, 800),
            InstallProgressSource::Remote,
        )
        .is_err());
    for (steps, time) in [(2, 900), (6, 600), (7, 650), (6, 700)] {
        let mut stale = receipt(&first, "running", steps, time);
        stale.log = vec!["Delayed receipt must not replace the newer log".into()];
        assert_ignored(&setup, &latest_first, stale, InstallProgressSource::Remote);
        assert_same_entry(&setup.entry(&second.id).unwrap(), &latest_second);
    }
    let reopened = Setup::new(root.clone()).unwrap();
    assert_same_entry(&reopened.entry(&first.id).unwrap(), &latest_first);
    assert_same_entry(&reopened.entry(&second.id).unwrap(), &latest_second);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn older_install_status_reply_returns_the_newer_stored_receipt() {
    let (root, setup, entry, _) = fixture();
    setup
        .store_install(
            &entry.id,
            receipt(&entry, "authorizing", 0, 1_000_000),
            InstallProgressSource::Local,
        )
        .unwrap();
    let old = receipt(&entry, "running", 0, 10);
    let latest = receipt(&entry, "running", 0, 20);
    fs::write(
        root.join("receipt.json"),
        serde_json::to_vec(&latest).unwrap(),
    )
    .unwrap();
    let accepted = setup.install_status(&entry.id, false).unwrap();
    assert_eq!(accepted.installation.as_ref().unwrap().updated_at, 20);
    fs::write(root.join("receipt.json"), serde_json::to_vec(&old).unwrap()).unwrap();
    assert_same_entry(&setup.install_status(&entry.id, false).unwrap(), &accepted);
    assert_same_entry(
        &Setup::new(root.clone()).unwrap().entry(&entry.id).unwrap(),
        &accepted,
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn install_storage_binds_all_receipt_ids_to_both_current_plan_and_installation() {
    let (root, setup, entry, _) = fixture();
    let valid = receipt(&entry, "running", 2, 20);
    for field in ["operationId", "environmentId", "releaseId"] {
        let mut value = serde_json::to_value(&valid).unwrap();
        value[field] = if field == "releaseId" {
            json!(format!("host-{}", "b".repeat(20)))
        } else {
            json!(Uuid::new_v4().to_string())
        };
        let mismatched: InstallProgress = serde_json::from_value(value.clone()).unwrap();
        let before = setup.entry(&entry.id).unwrap();
        let journal = fs::read(setup.directory.join("entries.json")).unwrap();
        assert!(setup
            .store_install(&entry.id, mismatched.clone(), InstallProgressSource::Remote)
            .unwrap_err()
            .contains("approved operation"));
        assert_same_entry(&setup.entry(&entry.id).unwrap(), &before);
        assert_eq!(
            fs::read(setup.directory.join("entries.json")).unwrap(),
            journal
        );

        // An in-flight response must also match the plan currently under the lock.
        let mut changed_plan = entry.clone();
        let mut plan = serde_json::to_value(changed_plan.plan.as_ref().unwrap()).unwrap();
        plan[field] = value[field].clone();
        changed_plan.plan = Some(serde_json::from_value(plan).unwrap());
        changed_plan.installation = Some(valid.clone());
        setup
            .inner
            .lock()
            .unwrap()
            .entries
            .insert(entry.id.clone(), changed_plan.clone());
        assert!(setup
            .store_install(&entry.id, valid.clone(), InstallProgressSource::Remote)
            .is_err());
        assert_same_entry(&setup.entry(&entry.id).unwrap(), &changed_plan);

        let mut changed_installation = entry.clone();
        changed_installation.installation = Some(mismatched);
        setup
            .inner
            .lock()
            .unwrap()
            .entries
            .insert(entry.id.clone(), changed_installation.clone());
        assert!(setup
            .store_install(&entry.id, valid.clone(), InstallProgressSource::Remote)
            .is_err());
        assert_same_entry(&setup.entry(&entry.id).unwrap(), &changed_installation);
        setup
            .inner
            .lock()
            .unwrap()
            .entries
            .insert(entry.id.clone(), entry.clone());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_launch_states_resolve_on_the_remote_clock_and_cannot_erase_receipts() {
    for state in ["authorizing", "unknown"] {
        for local_time in [0, 1_000_000] {
            let (root, setup, entry, _) = fixture();
            let mut local = receipt(&entry, state, 0, local_time);
            local.started_at = local_time;
            setup
                .store_install(&entry.id, local, InstallProgressSource::Local)
                .unwrap();
            // First real receipt is allowed even when the host clock is behind this Mac.
            let running = setup
                .store_install(
                    &entry.id,
                    receipt(&entry, "running", 0, 100),
                    InstallProgressSource::Remote,
                )
                .unwrap();
            assert_eq!(running.installation.as_ref().unwrap().state, "running");
            assert_eq!(
                running.installation.as_ref().unwrap().remote_updated_at,
                Some(100)
            );
            for late_state in ["unknown", "authorizing"] {
                assert_ignored(
                    &setup,
                    &running,
                    receipt(&entry, late_state, 0, 2_000_000),
                    InstallProgressSource::Local,
                );
            }
            for stale_state in ["queued", "unknown"] {
                assert_ignored(
                    &setup,
                    &running,
                    receipt(&entry, stale_state, 0, 100),
                    InstallProgressSource::Remote,
                );
            }
            fs::remove_dir_all(root).unwrap();
        }
    }
}

#[test]
fn remote_unknown_freshness_is_runtime_scoped_and_allows_same_timestamp_resolution() {
    let (root, setup, entry, _) = fixture();
    let mut unknown = receipt(&entry, "unknown", 0, 100);
    unknown.remote_updated_at = Some(9_000_000);
    let unknown = setup
        .store_install(&entry.id, unknown, InstallProgressSource::Remote)
        .unwrap();
    assert_eq!(
        unknown.installation.as_ref().unwrap().remote_updated_at,
        Some(100)
    );
    assert_ignored(
        &setup,
        &unknown,
        receipt(&entry, "running", 0, 99),
        InstallProgressSource::Remote,
    );
    for state in ["authorizing", "unknown"] {
        assert_ignored(
            &setup,
            &unknown,
            receipt(&entry, state, 0, 2_000_000),
            InstallProgressSource::Local,
        );
    }
    let resolved = setup
        .store_install(
            &entry.id,
            receipt(&entry, "running", 0, 100),
            InstallProgressSource::Remote,
        )
        .unwrap();
    assert_eq!(resolved.installation.as_ref().unwrap().state, "running");
    assert_eq!(resolved.installation.as_ref().unwrap().error, None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn install_progress_json_roundtrip_preserves_the_old_strict_shape() {
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct OldInstallProgress {
        operation_id: String,
        environment_id: String,
        release_id: String,
        state: String,
        completed_steps: u8,
        total_steps: u8,
        stage: String,
        started_at: u64,
        updated_at: u64,
        log: Vec<String>,
        error: Option<String>,
    }

    let (root, _, entry, _) = fixture();
    for state in [
        "authorizing",
        "unknown",
        "queued",
        "running",
        "ready",
        "failed",
        "cancelled",
        "interrupted",
        "complete",
    ] {
        let steps = match state {
            "ready" => 10,
            "complete" => 12,
            _ => 0,
        };
        let mut progress = receipt(&entry, state, steps, 100);
        progress.remote_updated_at = Some(99);
        let json = serde_json::to_value(&progress).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 11);
        assert!(json.get("remoteUpdatedAt").is_none());
        let old: OldInstallProgress = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(old).unwrap(), json);
        let reloaded: InstallProgress = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(&reloaded).unwrap(), json);
        assert_eq!(reloaded.remote_updated_at, None);
        assert_eq!(
            reloaded.remote_timestamp(),
            match state {
                "queued" | "running" | "ready" | "failed" | "cancelled" | "interrupted" =>
                    Some(100),
                _ => None,
            }
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unknown_after_restart_relearns_remote_clock_without_relaxing_identity_or_steps() {
    let (root, setup, entry, _) = fixture();
    setup
        .store_install(
            &entry.id,
            receipt(&entry, "unknown", 3, 1_000_000),
            InstallProgressSource::Remote,
        )
        .unwrap();
    let reopened = Setup::new(root.clone()).unwrap();
    let unknown = reopened.entry(&entry.id).unwrap();
    assert_eq!(
        unknown.installation.as_ref().unwrap().remote_timestamp(),
        None
    );
    assert_ignored(
        &reopened,
        &unknown,
        receipt(&entry, "running", 2, 2_000_000),
        InstallProgressSource::Remote,
    );
    let mut mismatched = receipt(&entry, "running", 3, 100);
    mismatched.operation_id = Uuid::new_v4().to_string();
    assert!(reopened
        .store_install(&entry.id, mismatched, InstallProgressSource::Remote)
        .is_err());
    assert_same_entry(&reopened.entry(&entry.id).unwrap(), &unknown);
    // A persisted unknown could have been local. Accept the first bound, nonregressing
    // remote resolution even with an earlier timestamp, then enforce its clock again.
    let resolved = reopened
        .store_install(
            &entry.id,
            receipt(&entry, "running", 3, 100),
            InstallProgressSource::Remote,
        )
        .unwrap();
    assert_eq!(resolved.installation.as_ref().unwrap().state, "running");
    assert_eq!(
        resolved.installation.as_ref().unwrap().remote_updated_at,
        Some(100)
    );
    assert_ignored(
        &reopened,
        &resolved,
        receipt(&entry, "running", 3, 99),
        InstallProgressSource::Remote,
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn explicit_same_operation_retry_can_resolve_a_remote_unknown_receipt() {
    let (root, setup, entry, archive) = fixture();
    let plan = entry.plan.as_ref().unwrap();
    setup
        .store_install(
            &entry.id,
            receipt(&entry, "unknown", 0, 1),
            InstallProgressSource::Remote,
        )
        .unwrap();
    let resolved = setup
        .start_install(
            &entry.id,
            &plan.plan_id,
            true,
            true,
            false,
            archive,
            (plan.device_id.clone(), plan.public_key.clone()),
        )
        .unwrap();
    let progress = resolved.installation.unwrap();
    assert_eq!(progress.state, "ready");
    assert_eq!(progress.completed_steps, 10);
    assert_eq!(progress.operation_id, plan.operation_id);
    assert_eq!(progress.environment_id, plan.environment_id);
    assert_eq!(progress.release_id, plan.release_id);
    assert_eq!(progress.remote_updated_at, Some(2));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_receipts_use_remote_freshness_only_when_the_clock_origin_is_known() {
    for state in ["running", "unknown", "authorizing"] {
        let (root, setup, mut entry, _) = fixture();
        entry.installation = Some(receipt(&entry, state, 0, 1_000_000));
        {
            let mut inner = setup.inner.lock().unwrap();
            inner.entries.insert(entry.id.clone(), entry.clone());
            setup.persist(&inner).unwrap();
        }
        let reopened = Setup::new(root.clone()).unwrap();
        let resolved = reopened
            .store_install(
                &entry.id,
                receipt(&entry, "running", 0, 100),
                InstallProgressSource::Remote,
            )
            .unwrap();
        if state == "running" {
            assert_same_entry(&resolved, &entry);
        } else {
            assert_eq!(resolved.installation.as_ref().unwrap().state, "running");
            assert_eq!(
                resolved.installation.as_ref().unwrap().remote_updated_at,
                Some(100)
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn stopped_installations_require_strictly_newer_nonregressing_remote_recovery() {
    for state in ["failed", "cancelled", "interrupted"] {
        for recovery in ["running", "ready"] {
            let (root, setup, entry, _) = fixture();
            setup
                .store_install(
                    &entry.id,
                    receipt(&entry, "running", 4, 100),
                    InstallProgressSource::Remote,
                )
                .unwrap();
            // A stopped observation can share the running receipt's timestamp, especially
            // an inferred interruption, but an in-flight running reply cannot undo it.
            let stopped = setup
                .store_install(
                    &entry.id,
                    receipt(&entry, state, 4, 100),
                    InstallProgressSource::Remote,
                )
                .unwrap();
            assert_eq!(stopped.phase, "installation_stopped");
            for (steps, time) in [(4, 99), (4, 100), (5, 100), (3, 101)] {
                assert_ignored(
                    &setup,
                    &stopped,
                    receipt(&entry, "running", steps, time),
                    InstallProgressSource::Remote,
                );
            }
            assert_ignored(
                &setup,
                &stopped,
                receipt(&entry, "unknown", 0, 1_000_000),
                InstallProgressSource::Local,
            );
            assert_ignored(
                &setup,
                &stopped,
                receipt(&entry, "ready", 10, 100),
                InstallProgressSource::Remote,
            );
            let recovered = setup
                .store_install(
                    &entry.id,
                    receipt(
                        &entry,
                        recovery,
                        if recovery == "ready" { 10 } else { 4 },
                        101,
                    ),
                    InstallProgressSource::Remote,
                )
                .unwrap();
            assert_eq!(recovered.installation.as_ref().unwrap().state, recovery);
            assert_eq!(recovered.installation.as_ref().unwrap().error, None);
            assert_ignored(
                &setup,
                &recovered,
                receipt(&entry, state, 4, 100),
                InstallProgressSource::Remote,
            );
            assert_eq!(
                recovered.phase,
                if recovery == "ready" {
                    "installed"
                } else {
                    "installing"
                }
            );
            fs::remove_dir_all(root).unwrap();
        }
    }
}

#[test]
fn ready_and_registered_installations_do_not_regress_across_clock_domains() {
    let (root, setup, entry, _) = fixture();
    let ready = setup
        .store_install(
            &entry.id,
            receipt(&entry, "ready", 10, 1_000_000),
            InstallProgressSource::Remote,
        )
        .unwrap();
    assert_eq!(ready.phase, "installed");
    for state in ["running", "failed", "cancelled", "interrupted", "ready"] {
        assert_ignored(
            &setup,
            &ready,
            receipt(&entry, state, 10, 2_000_000),
            InstallProgressSource::Remote,
        );
    }
    let completed = setup
        .store_install(
            &entry.id,
            receipt(&entry, "complete", 12, 100),
            InstallProgressSource::Local,
        )
        .unwrap();
    assert_eq!(completed.phase, "tunnel_ready");
    let progress = completed.installation.as_ref().unwrap();
    assert_eq!(progress.state, "complete");
    assert_eq!(progress.completed_steps, 12);
    assert_eq!(progress.updated_at, 100);
    assert_eq!(progress.remote_updated_at, Some(1_000_000));
    for state in [
        "queued",
        "unknown",
        "running",
        "failed",
        "cancelled",
        "interrupted",
        "ready",
    ] {
        assert_ignored(
            &setup,
            &completed,
            receipt(
                &entry,
                state,
                if state == "ready" { 10 } else { 0 },
                3_000_000,
            ),
            InstallProgressSource::Remote,
        );
    }
    assert_ignored(
        &setup,
        &completed,
        receipt(&entry, "complete", 12, 4_000_000),
        InstallProgressSource::Local,
    );
    // Completion remains native-only; a host cannot claim authenticated registration.
    assert!(setup
        .store_install(
            &entry.id,
            receipt(&entry, "complete", 12, 4_000_000),
            InstallProgressSource::Remote
        )
        .is_err());
    let reopened = Setup::new(root.clone()).unwrap();
    let saved = reopened.entry(&entry.id).unwrap();
    assert_eq!(saved.installation.as_ref().unwrap().state, "complete");
    assert_ignored(
        &reopened,
        &saved,
        receipt(&entry, "ready", 10, 5_000_000),
        InstallProgressSource::Remote,
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_completion_requires_a_ready_receipt_for_the_same_operation() {
    let (root, setup, entry, _) = fixture();
    assert!(setup
        .store_install(
            &entry.id,
            receipt(&entry, "complete", 12, 100),
            InstallProgressSource::Local
        )
        .is_err());
    setup
        .store_install(
            &entry.id,
            receipt(&entry, "running", 9, 100),
            InstallProgressSource::Remote,
        )
        .unwrap();
    assert!(setup
        .store_install(
            &entry.id,
            receipt(&entry, "complete", 12, 200),
            InstallProgressSource::Local
        )
        .is_err());
    let ready = setup
        .store_install(
            &entry.id,
            receipt(&entry, "ready", 10, 300),
            InstallProgressSource::Remote,
        )
        .unwrap();
    let mut wrong_completion = receipt(&entry, "complete", 12, 400);
    wrong_completion.operation_id = Uuid::new_v4().to_string();
    assert!(setup
        .store_install(&entry.id, wrong_completion, InstallProgressSource::Local)
        .is_err());
    assert_same_entry(&setup.entry(&entry.id).unwrap(), &ready);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn injected_launch_gets_exact_source_password_free_frame_and_durable_authorization() {
    let (root, setup, entry, archive) = fixture();
    let plan = entry.plan.as_ref().unwrap();
    let result = setup.start_install_with(&entry.id, &plan.plan_id, true, true, archive,
        (plan.device_id.clone(), plan.public_key.clone()), |bound, source, frame, cancel| {
            assert_eq!(bound.id, entry.id);
            assert!(bound.installation.is_none());
            assert_eq!(source, INSTALLER);
            assert!(!cancel.load(Ordering::SeqCst));
            let newline = frame.iter().position(|byte| *byte == b'\n').unwrap();
            let request: Value = serde_json::from_slice(&frame[..newline]).unwrap();
            assert_eq!(request, json!({"operationId":plan.operation_id,"environmentId":plan.environment_id,
                "deviceId":plan.device_id,"publicKey":plan.public_key,"label":entry.label,"releaseId":plan.release_id,
                "sha256":plan.sha256,"size":plan.size,"browser":false,"fullControl":true,"coexistence":true}));
            assert_eq!(&frame[newline+1..], b"synthetic-release");
            let saved: Value = serde_json::from_slice(&fs::read(setup.directory.join("entries.json")).unwrap()).unwrap();
            assert_eq!(saved[&entry.id]["installation"]["state"], "authorizing");
            assert!(setup.inner.lock().unwrap().activities.contains_key(&entry.id));
            Ok(serde_json::to_vec(&receipt(&entry,"ready",10,now())).unwrap())
        }).unwrap();
    assert_eq!(result.installation.unwrap().state, "ready");
    assert!(setup.inner.lock().unwrap().activities.is_empty());
    assert!(setup.inner.lock().unwrap().running.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn injected_launch_preserves_all_native_approval_identity_expiry_and_digest_guards() {
    for case in 0..7 {
        let (root, setup, mut entry, archive) = fixture();
        if case == 4 {
            entry.plan.as_mut().unwrap().expires_at = 0;
            setup
                .inner
                .lock()
                .unwrap()
                .entries
                .insert(entry.id.clone(), entry.clone());
        }
        if case == 5 {
            fs::write(&archive, b"different-release").unwrap();
        }
        let plan = entry.plan.as_ref().unwrap();
        let guard = if case == 6 {
            Some(
                setup
                    .activity(&entry.id, history::ActivityKind::Diagnostics)
                    .unwrap(),
            )
        } else {
            None
        };
        let result = setup.start_install_with(
            &entry.id,
            if case == 1 {
                "wrong-plan"
            } else {
                &plan.plan_id
            },
            case != 0,
            case != 2,
            archive,
            (
                if case == 3 {
                    Uuid::new_v4().to_string()
                } else {
                    plan.device_id.clone()
                },
                plan.public_key.clone(),
            ),
            |_, _, _, _| panic!("guard failure must never dispatch"),
        );
        assert!(result.is_err(), "case {case}");
        assert!(setup.entry(&entry.id).unwrap().installation.is_none());
        drop(guard);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn injected_launch_failure_is_unknown_and_never_retried_by_common_code() {
    for malformed in [false, true] {
        let (root, setup, entry, archive) = fixture();
        let plan = entry.plan.as_ref().unwrap();
        let mut calls = 0;
        let result = setup
            .start_install_with(
                &entry.id,
                &plan.plan_id,
                true,
                true,
                archive,
                (plan.device_id.clone(), plan.public_key.clone()),
                |_, _, _, _| {
                    calls += 1;
                    if malformed {
                        Ok(b"not-json-private-output".to_vec())
                    } else {
                        Err("private transport error".into())
                    }
                },
            )
            .unwrap();
        assert_eq!(calls, 1);
        let progress = result.installation.unwrap();
        assert_eq!(progress.state, "unknown");
        assert_eq!(progress.operation_id, plan.operation_id);
        assert!(!serde_json::to_string(&progress)
            .unwrap()
            .contains("private"));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn injected_launch_cannot_publish_a_forged_remote_completion() {
    let (root, setup, entry, archive) = fixture();
    let plan = entry.plan.as_ref().unwrap();
    assert!(setup
        .start_install_with(
            &entry.id,
            &plan.plan_id,
            true,
            true,
            archive,
            (plan.device_id.clone(), plan.public_key.clone()),
            |_, _, _, _| {
                Ok(serde_json::to_vec(&receipt(&entry, "complete", 12, now())).unwrap())
            }
        )
        .is_err());
    assert_eq!(
        setup.entry(&entry.id).unwrap().installation.unwrap().state,
        "authorizing"
    );
    fs::remove_dir_all(root).unwrap();
}
