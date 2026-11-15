use super::*;

fn new_working_entry(f: &Fixture) -> String {
    let mut entry = f.entry.clone();
    entry.plan = None;
    entry.installation = None;
    entry.inspection = None;
    entry.phase = "trusted".into();
    entry.target.host = "FIXTURE.EXAMPLE.".into();
    entry.target.user = "replacement-admin".into();
    let key = f.root.join("replacement-private-key");
    private_write(&key, b"fixture-key-only").unwrap();
    entry.target.identity_file = Some(key.to_string_lossy().into_owned());
    add(f, entry)
}
fn unknown(f: &Fixture, registry: &environments::Registry) -> RestartReview {
    fs::write(f.root.join("lost"), b"").unwrap();
    let r = review(f, &f.entry.id);
    assert_eq!(apply(f, &r, registry).state, "unknown");
    r
}
fn stale_route_entry(setup: &Setup, id: &str) {
    let mut inner = setup.inner.lock().unwrap();
    let entry = inner.entries.get_mut(id).unwrap();
    entry.phase = "disconnected".into();
    entry.connection_paused = false;
    entry.endpoint = Some("http://127.0.0.1:1".into());
    entry.error = None;
    setup.persist(&inner).unwrap();
}
fn assert_fenced_entry(entry: &Entry, phase: &str) {
    assert_eq!(entry.phase, phase);
    assert!(entry.connection_paused);
    assert!(entry.endpoint.is_none());
    assert_eq!(entry.error.as_deref(), Some(HOLD));
}

#[test]
fn restart_status_absence_rejects_unverified_busy_and_unavailable_setups() {
    for problem in ["missing_pin", "changed_pin", "busy", "missing_id", "closed"] {
        let f = fixture();
        let pin = f
            .setup
            .directory
            .join(format!("{}.known_hosts", f.entry.id));
        let _busy = (problem == "busy").then(|| {
            f.setup
                .activity(&f.entry.id, ActivityKind::Diagnostics)
                .unwrap()
        });
        let id = match problem {
            "missing_pin" => {
                fs::remove_file(pin).unwrap();
                f.entry.id.clone()
            }
            "changed_pin" => {
                f.setup
                    .inner
                    .lock()
                    .unwrap()
                    .entries
                    .get_mut(&f.entry.id)
                    .unwrap()
                    .fingerprint = "SHA256:unverified".into();
                f.entry.id.clone()
            }
            "missing_id" => Uuid::new_v4().to_string(),
            "closed" => {
                f.setup.close();
                f.entry.id.clone()
            }
            _ => f.entry.id.clone(),
        };
        assert!(f.setup.reserve_restart_status(&id).is_err(), "{problem}");
        assert!(calls(&f).is_empty());
    }
    let f = fixture();
    let unavailable = Setup::unavailable(f.root.clone(), "Invalid restart journal".into());
    assert!(unavailable.reserve_restart_status(&f.entry.id).is_err());
}

#[test]
fn restart_status_absence_rejects_corrupt_unreadable_or_missing_local_history() {
    for name in ["restart-recovery/journal.json", "history.json"] {
        for problem in ["corrupt", "directory", "unsafe_permissions", "missing"] {
            if name == "history.json" && problem == "missing" {
                continue;
            }
            let f = fixture();
            let path = f.setup.directory.join(name);
            match problem {
                "corrupt" => private_write(&path, b"not json").unwrap(),
                "directory" => {
                    if path.exists() {
                        fs::remove_file(&path).unwrap();
                    }
                    fs::create_dir(&path).unwrap();
                }
                "unsafe_permissions" => {
                    if !path.exists() {
                        private_write(&path, br#"{"schemaVersion":1,"archived":[]}"#).unwrap();
                    }
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
                }
                _ => fs::remove_file(&path).unwrap(),
            }
            assert!(
                f.setup.reserve_restart_status(&f.entry.id).is_err(),
                "{name}: {problem}"
            );
            assert!(calls(&f).is_empty());
            assert!(f.setup.inner.lock().unwrap().activities.is_empty());
        }
    }
    for symlink in [false, true] {
        let f = fixture();
        let root = f.setup.directory.join("restart-recovery");
        let saved = f.setup.directory.join("saved-restart-recovery");
        fs::rename(&root, &saved).unwrap();
        if symlink {
            std::os::unix::fs::symlink(&saved, &root).unwrap();
        }
        assert!(f.setup.reserve_restart_status(&f.entry.id).is_err());
        if !symlink {
            assert!(
                !root.exists(),
                "status must not recreate missing recovery history"
            );
        }
        assert!(calls(&f).is_empty());
    }
}

#[test]
fn restart_status_absence_never_clears_a_fenced_entry_with_missing_record() {
    for phase in ["restart_pending", "reset"] {
        let f = fixture();
        {
            let mut inner = f.setup.inner.lock().unwrap();
            let entry = inner.entries.get_mut(&f.entry.id).unwrap();
            entry.phase = phase.into();
            entry.connection_paused = true;
            entry.error = Some(HOLD.into());
            f.setup.persist(&inner).unwrap();
        }
        let before = serde_json::to_value(f.setup.entry(&f.entry.id).unwrap()).unwrap();
        let reopened = Setup::new(f.root.clone()).unwrap();
        for setup in [&f.setup, &reopened] {
            assert!(
                setup.reserve_restart_status(&f.entry.id).is_err(),
                "{phase}"
            );
            assert_eq!(
                serde_json::to_value(setup.entry(&f.entry.id).unwrap()).unwrap(),
                before
            );
        }
        assert!(calls(&f).is_empty());
    }
}

#[test]
fn restart_status_absence_rechecks_queued_cancellation_identity_and_history() {
    for change in [
        "cancel", "token", "pin", "target", "phase", "journal", "history", "closed",
    ] {
        let f = fixture();
        let registry = registry(&f);
        let resolution = f.setup.reserve_restart_status(&f.entry.id).unwrap();
        assert!(matches!(&resolution, StatusResolution::None(_)));
        match change {
            "cancel" => f.setup.inner.lock().unwrap().activities[&f.entry.id]
                .cancel
                .store(true, Ordering::SeqCst),
            "token" => {
                f.setup
                    .inner
                    .lock()
                    .unwrap()
                    .activities
                    .get_mut(&f.entry.id)
                    .unwrap()
                    .token = Uuid::new_v4().to_string()
            }
            "pin" => fs::remove_file(
                f.setup
                    .directory
                    .join(format!("{}.known_hosts", f.entry.id)),
            )
            .unwrap(),
            "target" => {
                f.setup
                    .inner
                    .lock()
                    .unwrap()
                    .entries
                    .get_mut(&f.entry.id)
                    .unwrap()
                    .target
                    .port += 1
            }
            "phase" => {
                f.setup
                    .inner
                    .lock()
                    .unwrap()
                    .entries
                    .get_mut(&f.entry.id)
                    .unwrap()
                    .phase = "restart_pending".into()
            }
            "journal" => private_write(
                &f.setup.directory.join("restart-recovery/journal.json"),
                b"invalid",
            )
            .unwrap(),
            "history" => {
                private_write(&f.setup.directory.join("history.json"), b"invalid").unwrap()
            }
            _ => f.setup.close(),
        }
        assert!(
            f.setup.restart_status(resolution, &registry).is_err(),
            "{change}"
        );
        assert!(calls(&f).is_empty());
    }
}

#[test]
fn restart_status_absence_cannot_clear_an_unmatched_same_host_hold() {
    for durable_only in [false, true] {
        let f = fixture();
        let registry = registry(&f);
        unknown(&f, &registry);
        let id = new_working_entry(&f);
        let mut key = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
        key.extend([8; 32]);
        let (key, fingerprint) =
            parse_key(&format!("fixture ssh-ed25519 {}", STANDARD.encode(key))).unwrap();
        private_write(
            &f.setup.directory.join(format!("{id}.known_hosts")),
            format!("{} {key}\n", Setup::alias(&id)).as_bytes(),
        )
        .unwrap();
        {
            let mut inner = f.setup.inner.lock().unwrap();
            inner.entries.get_mut(&id).unwrap().fingerprint = fingerprint;
            if durable_only {
                inner.restart_journal.records.clear();
            }
            f.setup.persist(&inner).unwrap();
        }
        let entry = f.setup.entry(&id).unwrap();
        assert_eq!(
            entry.phase, "trusted",
            "test the hold even before phase projection"
        );
        f.setup.pinned_ssh_args(&entry).unwrap();
        assert!(
            f.setup.reserve_restart_status(&id).is_err(),
            "durable_only={durable_only}"
        );
        assert_eq!(
            calls(&f).len(),
            2,
            "unmatched holds never dispatch status or cleanup"
        );
    }
}

#[test]
fn restart_status_absence_rechecks_new_memory_and_durable_records() {
    for durable_only in [false, true] {
        let f = fixture();
        let registry = registry(&f);
        let path = f.setup.directory.join("restart-recovery/journal.json");
        let empty = fs::read(&path).unwrap();
        let request = f
            .setup
            .reserve_restart(&f.entry.id, &f.entry.id, false)
            .unwrap();
        let pending = f.setup.prepare_restart(&request).unwrap();
        drop(request);
        let saved = fs::read(&path).unwrap();
        f.setup
            .inner
            .lock()
            .unwrap()
            .restart_journal
            .records
            .clear();
        private_write(&path, &empty).unwrap();
        let resolution = f.setup.reserve_restart_status(&f.entry.id).unwrap();
        if durable_only {
            private_write(&path, &saved).unwrap();
        } else {
            f.setup
                .inner
                .lock()
                .unwrap()
                .restart_journal
                .records
                .insert(pending.reset_id.clone(), pending);
        }
        assert!(
            f.setup.restart_status(resolution, &registry).is_err(),
            "durable_only={durable_only}"
        );
        assert!(calls(&f).is_empty());
    }
}

#[test]
fn restart_status_absence_remains_available_for_an_unrelated_verified_host() {
    let f = fixture();
    let registry = registry(&f);
    unknown(&f, &registry);
    let mut peer = f.entry.clone();
    peer.target.host = "peer.example".into();
    peer.plan = None;
    peer.installation = None;
    peer.phase = "trusted".into();
    let id = add(&f, peer);
    assert_status_none(&f.setup, &id, &registry);
    assert_eq!(calls(&f).len(), 2);
}

#[test]
fn restart_apply_outcome_protocol_does_not_accept_status_only_absence() {
    let f = fixture();
    let request = f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, false)
        .unwrap();
    for state in ["complete", "unknown", "failed", "none"] {
        let reply = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "resetId": request.reset_id,
            "operationId": request.binding.expected.operation_id,
            "environmentId": request.binding.expected.environment_id,
            "releaseId": request.binding.expected.release_id,
            "state": state,
            "message": "Outcome metadata only."
        }))
        .unwrap();
        let parsed = parse_result(&reply, &request);
        if state == "none" {
            assert!(parsed.is_err());
        } else {
            let parsed = parsed.unwrap();
            assert_eq!(parsed.state, state);
            assert_eq!(parsed.message, "Outcome metadata only.");
        }
    }
    assert!(calls(&f).is_empty());
}

#[test]
fn restart_completion_snapshot_is_immutable_after_inspection_new_plan_and_reload() {
    let f = fixture();
    let registry = registry(&f);
    let r = review(&f, &f.entry.id);
    let created = apply(&f, &r, &registry).entry.unwrap();
    let creation_snapshot = serde_json::to_value(&created).unwrap();
    for with_plan in [false, true] {
        let newer = {
            let mut inner = f.setup.inner.lock().unwrap();
            let entry = inner.entries.get_mut(&created.id).unwrap();
            entry.inspection = Some(serde_json::from_value(json!({"version":1,"os":"ubuntu","osVersion":"24.04","architecture":"x86_64","systemd":true,"uid":1000,"freeBytes":20000000000_u64,"memoryBytes":4000000000_u64,"markers":[],"container":false,"sudo":"policy_readable","api":"absent","environment":null})).unwrap());
            entry.phase = if with_plan {
                "install_review"
            } else {
                "review"
            }
            .into();
            if with_plan {
                let mut plan = serde_json::to_value(&f.entry.plan).unwrap();
                plan["planId"] = json!(Uuid::new_v4().to_string());
                plan["operationId"] = json!(Uuid::new_v4().to_string());
                plan["environmentId"] = json!(Uuid::new_v4().to_string());
                entry.plan = Some(serde_json::from_value(plan).unwrap());
            }
            entry
                .log
                .push("New user work must survive completion reconciliation".into());
            let newer = serde_json::to_value(&entry).unwrap();
            f.setup.persist(&inner).unwrap();
            newer
        };
        let mut reopened = Setup::new(f.root.clone()).unwrap();
        reopened.ssh_fixture = f.setup.ssh_fixture.clone();
        let done = reopened
            .restart_status(
                reopened.reserve_restart_status(&f.entry.id).unwrap(),
                &registry,
            )
            .unwrap();
        assert_eq!(done.reset_id, r.reset_id);
        assert_eq!(
            serde_json::to_value(done.entry.unwrap()).unwrap(),
            creation_snapshot,
            "completion must return its creation event, not later mutable setup work"
        );
        let listed = reopened
            .list()
            .unwrap()
            .into_iter()
            .find(|e| e.id == created.id)
            .unwrap();
        assert_eq!(
            serde_json::to_value(listed).unwrap(),
            newer,
            "native reload must preserve the newer store entry"
        );
    }
    assert_eq!(
        calls(&f).len(),
        2,
        "local reconciliation never repeats cleanup or requires another remote read"
    );
}

#[test]
fn restart_status_rebinds_only_the_transport_for_a_new_verified_connection() {
    let f = fixture();
    let registry = registry(&f);
    let r = unknown(&f, &registry);
    let id = new_working_entry(&f);
    let mut reopened = Setup::new(f.root.clone()).unwrap();
    reopened.ssh_fixture = f.setup.ssh_fixture.clone();
    let resolution = reopened
        .reserve_restart_status(&id)
        .expect("new verified SSH details must recover the original reset");
    let StatusResolution::Pending(request) = &resolution else {
        panic!("a saved reset must resolve to a pending request, never absence");
    };
    assert_eq!(request.reset_id, r.reset_id);
    assert_eq!(request.binding.source_id, f.entry.id);
    assert_eq!(request.binding.target.user, "replacement-admin");
    let result = reopened.restart_status(resolution, &registry).unwrap();
    assert_eq!(result.state, "unknown");
    assert_eq!(result.reset_id, r.reset_id);
    assert!(
        reopened.reserve_restart(&id, &f.entry.id, false).is_err(),
        "a status transport never grants replay authority"
    );
    fs::write(f.root.join("remote-complete"), b"").unwrap();
    let done = reopened
        .restart_status(reopened.reserve_restart_status(&id).unwrap(), &registry)
        .unwrap();
    assert_eq!(done.state, "complete");
    assert_eq!(done.reset_id, r.reset_id);
    assert_eq!(
        done.entry.unwrap().target,
        f.entry.target,
        "the durable creation snapshot is not rewritten by a later status caller"
    );
    let listed = reopened.list().unwrap();
    assert_fenced_entry(listed.iter().find(|e| e.id == id).unwrap(), "reset");
    assert!(reopened.history_list().unwrap().contains(&id));
    let requests = calls(&f);
    assert_eq!(
        requests
            .iter()
            .filter(|c| c["request"]["mode"] == "apply")
            .count(),
        1
    );
    for call in requests.iter().filter(|c| c["request"]["mode"] == "status") {
        assert_eq!(call["request"]["resetId"], r.reset_id);
        assert_eq!(call["request"]["expected"]["operationId"], r.operation_id);
        let args = call["args"].as_array().unwrap();
        assert!(args.contains(&json!("replacement-admin")));
        assert!(args.contains(&json!(f
            .root
            .join("replacement-private-key")
            .to_string_lossy())));
        assert!(!args.last().unwrap().as_str().unwrap().contains("sudo "));
    }
}

#[test]
fn restart_status_rejects_ambiguous_host_matches_and_changed_host_port_or_pin() {
    let f = fixture();
    let registry = registry(&f);
    let r = unknown(&f, &registry);
    let id = new_working_entry(&f);
    let good = f
        .setup
        .list()
        .unwrap()
        .into_iter()
        .find(|e| e.id == id)
        .unwrap();
    assert_fenced_entry(&good, "restart_pending");
    for change in ["host", "port", "pin"] {
        let mut entry = good.clone();
        match change {
            "host" => entry.target.host = "different.example".into(),
            "port" => entry.target.port += 1,
            _ => entry.fingerprint = "SHA256:unverified".into(),
        }
        f.setup
            .inner
            .lock()
            .unwrap()
            .entries
            .insert(id.clone(), entry);
        assert!(
            f.setup.reserve_restart_status(&id).is_err(),
            "{change} must not resolve a reset"
        );
    }
    f.setup
        .inner
        .lock()
        .unwrap()
        .entries
        .insert(id.clone(), good);
    let mut duplicate = f.setup.inner.lock().unwrap().restart_journal.records[&r.reset_id].clone();
    duplicate.reset_id = Uuid::new_v4().to_string();
    // Both are candidates for the new connection, but the original entry still identifies one.
    duplicate.binding.id = Uuid::new_v4().to_string();
    duplicate.binding.source_id = Uuid::new_v4().to_string();
    duplicate.affected = BTreeSet::from([
        duplicate.binding.id.clone(),
        duplicate.binding.source_id.clone(),
    ]);
    f.setup
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .insert(duplicate.reset_id.clone(), duplicate.clone());
    let error = match f.setup.reserve_restart_status(&id) {
        Ok(_) => panic!("ambiguous host must not choose an arbitrary reset"),
        Err(error) => error,
    };
    assert!(error.contains("Multiple restart"), "{error}");
    assert!(
        error.contains(&r.reset_id) && error.contains(&duplicate.reset_id),
        "ambiguity must identify the explicit choices: {error}"
    );
    let StatusResolution::Pending(request) = f.setup.reserve_restart_status(&f.entry.id).unwrap()
    else {
        panic!("the explicit original setup must still resolve its saved reset");
    };
    assert_eq!(request.reset_id, r.reset_id);
    assert_eq!(calls(&f).len(), 2);
}

#[test]
fn restart_phase_survives_supervisor_disconnect_and_is_projected_on_load_and_list() {
    let f = fixture();
    let registry = registry(&f);
    unknown(&f, &registry);
    for complete in [false, true] {
        let phase = if complete { "reset" } else { "restart_pending" };
        if complete {
            fs::write(f.root.join("remote-complete"), b"").unwrap();
            let result = f
                .setup
                .restart_status(
                    f.setup.reserve_restart_status(&f.entry.id).unwrap(),
                    &registry,
                )
                .unwrap();
            assert_eq!(result.state, "complete");
        }
        let evidence =
            serde_json::to_value(&f.setup.entry(&f.entry.id).unwrap().installation).unwrap();
        for _ in 0..2 {
            assert_fenced_entry(&f.setup.disconnect(&f.entry.id).unwrap(), phase);
            assert_fenced_entry(&f.setup.pause_route(&f.entry.id).unwrap(), phase);
        }
        stale_route_entry(&f.setup, &f.entry.id);
        let listed = f.setup.list().unwrap();
        assert_fenced_entry(listed.iter().find(|e| e.id == f.entry.id).unwrap(), phase);
        stale_route_entry(&f.setup, &f.entry.id);
        let reopened = Setup::new(f.root.clone()).unwrap();
        assert_fenced_entry(&reopened.entry(&f.entry.id).unwrap(), phase);
        assert_eq!(
            serde_json::to_value(&reopened.entry(&f.entry.id).unwrap().installation).unwrap(),
            evidence
        );
        assert!(reopened.begin(&f.entry.id).is_err());
        let disk: Value =
            serde_json::from_slice(&fs::read(reopened.directory.join("entries.json")).unwrap())
                .unwrap();
        assert_eq!(disk[&f.entry.id]["phase"], phase);
    }
}
