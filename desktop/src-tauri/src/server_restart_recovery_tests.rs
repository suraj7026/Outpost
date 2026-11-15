use super::*;

const FAILURE: &str = "Inspected state changed since review; no cleanup started.";
const CANARY: &str = "untrusted-output-secret-canary";

fn held() -> (Fixture, environments::Registry, RestartReview) {
    let f = fixture();
    let registry = registry(&f);
    fs::write(f.root.join("apply-failed"), b"").unwrap();
    let r = review(&f, &f.entry.id);
    let result = apply(&f, &r, &registry);
    assert_eq!(result.state, "failed");
    assert!(result.message.contains(FAILURE));
    fs::remove_file(f.root.join("apply-failed")).unwrap();
    (f, registry, r)
}

fn recovery_review(f: &Fixture, registry: &environments::Registry, reset: &str) -> RestartReview {
    f.setup
        .restart_recovery_review_with(
            f.setup
                .reserve_restart_recovery(&f.entry.id, reset, true)
                .unwrap(),
            registry,
            |entry, purpose, password, cancel| {
                assert_eq!(purpose, "recover_review");
                allow(entry, purpose, password, cancel)
            },
        )
        .unwrap()
}

fn recovery_apply(f: &Fixture, review: &RestartReview) -> ApplyRequest {
    f.setup
        .reserve_restart_recovery_apply(&f.entry.id, &review.review_id, &review.host, true)
        .unwrap()
}

fn journal_value(f: &Fixture) -> Value {
    serde_json::from_slice(
        &fs::read(f.setup.directory.join("restart-recovery/journal.json")).unwrap(),
    )
    .unwrap()
}

fn save_journal(f: &Fixture, value: &Value, memory: bool) {
    private_write(
        &f.setup.directory.join("restart-recovery/journal.json"),
        &serde_json::to_vec(value).unwrap(),
    )
    .unwrap();
    if memory {
        f.setup.inner.lock().unwrap().restart_journal = Journal::read(&f.setup.directory).unwrap();
    }
}

fn saved_files(f: &Fixture) -> Vec<Vec<u8>> {
    [
        "server-setup/entries.json",
        "server-setup/restart-recovery/journal.json",
        "environments/registry.json",
        "environments/restart-fences/journal.json",
    ]
    .map(|p| fs::read(f.root.join(p)).unwrap())
    .to_vec()
}

fn reserved_fresh(f: &Fixture, reset: &str) -> Entry {
    serde_json::from_value(journal_value(f)["records"][reset]["fresh"].clone()).unwrap()
}

fn publish_test_entry(f: &Fixture, entry: &Entry) {
    let pin = fs::read_to_string(
        f.setup
            .directory
            .join(format!("{}.known_hosts", f.entry.id)),
    )
    .unwrap();
    let (key, _) = parse_key(&pin).unwrap();
    private_write(
        &f.setup.directory.join(format!("{}.known_hosts", entry.id)),
        format!("{} {key}\n", Setup::alias(&entry.id)).as_bytes(),
    )
    .unwrap();
    let mut inner = f.setup.inner.lock().unwrap();
    inner.entries.insert(entry.id.clone(), entry.clone());
    f.setup.persist(&inner).unwrap();
}

#[test]
fn recovery_refuses_reserved_fresh_id_occupancy_at_every_dispatch_boundary() {
    for applying in [false, true] {
        for timing in ["before-reservation", "queued", "authorization", "remote"] {
            let (f, registry, held) = held();
            let review = applying.then(|| recovery_review(&f, &registry, &held.reset_id));
            let mut occupant = reserved_fresh(&f, &held.reset_id);
            occupant.target.host = "unrelated.example".into();
            occupant
                .log
                .push("Unrelated entry must not be replaced".into());
            let journal = journal_value(&f);
            let count = calls(&f).len();
            if timing == "before-reservation" {
                publish_test_entry(&f, &occupant);
                if let Some(review) = &review {
                    assert!(f
                        .setup
                        .reserve_restart_recovery_apply(
                            &f.entry.id,
                            &review.review_id,
                            &review.host,
                            true
                        )
                        .is_err());
                } else {
                    assert!(f
                        .setup
                        .reserve_restart_recovery(&f.entry.id, &held.reset_id, true)
                        .is_err());
                }
            } else {
                let request = if let Some(review) = &review {
                    Err(recovery_apply(&f, review))
                } else {
                    Ok(f.setup
                        .reserve_restart_recovery(&f.entry.id, &held.reset_id, true)
                        .unwrap())
                };
                if timing == "queued" {
                    publish_test_entry(&f, &occupant);
                }
                if timing == "remote" {
                    fs::write(
                        f.root.join("pause-helper-mode"),
                        if applying {
                            "recover_apply"
                        } else {
                            "recover_review"
                        },
                    )
                    .unwrap();
                }
                let result = std::thread::scope(|scope| {
                    let worker = (timing == "remote").then(|| {
                        scope.spawn(|| {
                            let deadline = Instant::now() + Duration::from_secs(10);
                            while !f.root.join("helper-entered").exists() {
                                assert!(
                                    Instant::now() < deadline,
                                    "synthetic helper never entered"
                                );
                                std::thread::sleep(Duration::from_millis(5));
                            }
                            publish_test_entry(&f, &occupant);
                            fs::write(f.root.join("helper-release"), b"").unwrap();
                        })
                    });
                    let auth = |entry: &Entry, mode: &str, password: bool, cancel: &AtomicBool| {
                        assert_ne!(
                            timing, "queued",
                            "occupied fresh ID must fail before consent"
                        );
                        if timing == "authorization" {
                            publish_test_entry(&f, &occupant);
                        }
                        allow(entry, mode, password, cancel)
                    };
                    let result = match request {
                        Ok(request) => f
                            .setup
                            .restart_recovery_review_with(request, &registry, auth)
                            .map(|_| None),
                        Err(request) => f
                            .setup
                            .restart_recovery_apply_with(request, &registry, auth)
                            .map(Some),
                    };
                    if let Some(worker) = worker {
                        worker.join().unwrap();
                    }
                    result
                });
                if applying && timing == "remote" {
                    let result = result.unwrap().unwrap();
                    assert_eq!(result.state, "unknown");
                    assert!(result.entry.is_none());
                } else {
                    assert!(
                        result.is_err(),
                        "occupied fresh ID accepted during {timing}"
                    );
                }
            }
            assert_eq!(
                serde_json::to_value(f.setup.entry(&occupant.id).unwrap()).unwrap(),
                serde_json::to_value(&occupant).unwrap()
            );
            assert_eq!(
                journal_value(&f),
                journal,
                "collision must not publish completion or replace the hold"
            );
            assert_eq!(calls(&f).len(), count + usize::from(timing == "remote"));
            assert!(registry.get(&held.environment_id).is_err());
            let reopened = Setup::new(f.root.clone()).unwrap();
            assert_eq!(
                serde_json::to_value(reopened.entry(&occupant.id).unwrap()).unwrap(),
                serde_json::to_value(&occupant).unwrap()
            );
        }
    }
}

#[test]
fn common_completion_rejects_unrelated_fresh_id_occupants_without_overwrite() {
    for completed in [false, true] {
        for mismatch in ["host", "fingerprint", "unpublished-state"] {
            if completed && mismatch == "unpublished-state" {
                continue;
            }
            let (f, registry, r) = held();
            let fresh = reserved_fresh(&f, &r.reset_id);
            if completed {
                assert_eq!(
                    f.setup
                        .reconcile_restart(&r.reset_id, "complete", None, &registry)
                        .unwrap()
                        .state,
                    "complete"
                );
            }
            let mut occupant = fresh;
            match mismatch {
                "host" => occupant.target.host = "unrelated.example".into(),
                "fingerprint" => occupant.fingerprint = "SHA256:foreign".into(),
                "unpublished-state" => occupant.log.push("Different unpublished work".into()),
                _ => unreachable!(),
            }
            publish_test_entry(&f, &occupant);
            let result = f
                .setup
                .reconcile_restart(&r.reset_id, "complete", None, &registry)
                .unwrap();
            assert_eq!(result.state, "unknown");
            assert!(result.entry.is_none());
            assert_eq!(
                serde_json::to_value(f.setup.entry(&occupant.id).unwrap()).unwrap(),
                serde_json::to_value(&occupant).unwrap()
            );
            assert_eq!(
                journal_value(&f)["records"][&r.reset_id]["localComplete"],
                completed
            );
        }
    }
}

#[test]
fn common_completion_accepts_exact_publication_retry_and_preserves_later_work() {
    let (f, registry, r) = held();
    let fresh = reserved_fresh(&f, &r.reset_id);
    publish_test_entry(&f, &fresh);
    let result = f
        .setup
        .reconcile_restart(&r.reset_id, "complete", None, &registry)
        .unwrap();
    assert_eq!(result.state, "complete");
    assert_eq!(
        serde_json::to_value(result.entry.unwrap()).unwrap(),
        serde_json::to_value(&fresh).unwrap()
    );
    let mut newer = fresh.clone();
    newer.label = "Newer label".into();
    newer.log.push("Later work must survive".into());
    publish_test_entry(&f, &newer);
    let reopened = Setup::new(f.root.clone()).unwrap();
    let result = reopened
        .reconcile_restart(&r.reset_id, "complete", None, &registry)
        .unwrap();
    assert_eq!(result.state, "complete");
    assert_eq!(
        serde_json::to_value(result.entry.unwrap()).unwrap(),
        serde_json::to_value(&fresh).unwrap()
    );
    assert_eq!(
        serde_json::to_value(reopened.entry(&fresh.id).unwrap()).unwrap(),
        serde_json::to_value(&newer).unwrap()
    );
}

#[test]
fn blocked_recovery_review_without_token_preserves_bounded_reasons_and_hold() {
    for (marker, reason) in [
        ("active", "Installer is active; stop and review again."),
        (
            "recovery-intent",
            "Recovery preparation contains deletion intent; no replay allowed.",
        ),
        (
            "interrupt-preparation",
            "Recovery preparation publication is unconfirmed.",
        ),
    ] {
        let (f, registry, r) = held();
        fs::write(f.root.join(marker), b"").unwrap();
        let before = saved_files(&f);
        let review = recovery_review(&f, &registry, &r.reset_id);
        assert!(!review.can_reset);
        assert_eq!(review.blockers, [reason]);
        let inner = f.setup.inner.lock().unwrap();
        assert!(inner.restart_reviews[0].recovery_token.is_none());
        drop(inner);
        assert!(f
            .setup
            .reserve_restart_recovery_apply(&f.entry.id, &review.review_id, &review.host, true)
            .is_err());
        assert_eq!(saved_files(&f), before);
        assert!(!f.root.join("recovery-intent").exists() || marker == "recovery-intent");
        assert_eq!(
            f.root.join("recovery-preparation.json").exists(),
            marker == "interrupt-preparation"
        );
        let status = f
            .setup
            .restart_status(
                f.setup.reserve_restart_status(&f.entry.id).unwrap(),
                &registry,
            )
            .unwrap();
        assert_eq!(status.state, "unknown");
        assert!(status.message.contains(FAILURE));
        assert_eq!(saved_files(&f), before);
    }
}

#[test]
fn resettable_recovery_without_token_and_malformed_blocked_reviews_are_rejected() {
    for patch in [
        None,
        Some(json!({"canReset":false,"blockers":[format!("{CANARY}\n")]})),
        Some(json!({"canReset":false,"blockers":["x".repeat(1001)]})),
        Some(json!({"canReset":false,"blockers":["Blocked"],"resetId":PEER})),
    ] {
        let (f, registry, r) = held();
        fs::write(f.root.join("omit-recovery-token"), b"").unwrap();
        if let Some(patch) = patch {
            fs::write(
                f.root.join("review-patch.json"),
                serde_json::to_vec(&patch).unwrap(),
            )
            .unwrap();
        }
        let before = saved_files(&f);
        let error = f
            .setup
            .restart_recovery_review_with(
                f.setup
                    .reserve_restart_recovery(&f.entry.id, &r.reset_id, true)
                    .unwrap(),
                &registry,
                allow,
            )
            .unwrap_err();
        assert!(error.starts_with("[serverProtocol:recover_review]"));
        assert!(!error.contains(CANARY));
        assert!(f.setup.inner.lock().unwrap().restart_reviews.is_empty());
        assert_eq!(saved_files(&f), before);
    }
}

#[test]
fn validated_failure_survives_unknown_status_and_reload_without_changing_the_hold() {
    let (f, registry, r) = held();
    let before = saved_files(&f);
    let mut reopened = Setup::new(f.root.clone()).unwrap();
    reopened.ssh_fixture = f.setup.ssh_fixture.clone();
    for setup in [&f.setup, &reopened] {
        let result = setup
            .restart_status(
                setup.reserve_restart_status(&f.entry.id).unwrap(),
                &registry,
            )
            .unwrap();
        assert_eq!(result.state, "unknown");
        assert!(result.message.contains(FAILURE));
        assert!(result
            .message
            .contains("Check restart outcome; do not repeat cleanup or installation."));
        assert!(!result.message.contains("Outcome metadata only."));
        assert_eq!(setup.entry(&f.entry.id).unwrap().phase, "restart_pending");
        assert!(setup
            .reserve_restart(&f.entry.id, &f.entry.id, false)
            .is_err());
    }
    assert_eq!(saved_files(&f), before);
    assert_eq!(
        journal_value(&f)["records"][&r.reset_id]["lastFailure"],
        FAILURE
    );
    assert!(!String::from_utf8(before.concat())
        .unwrap()
        .contains("fixture-secret"));
}

#[test]
fn old_journals_default_failure_and_malformed_persisted_messages_fail_closed() {
    let (f, _, r) = held();
    let mut original = journal_value(&f);
    original["records"][&r.reset_id]
        .as_object_mut()
        .unwrap()
        .remove("lastFailure");
    save_journal(&f, &original, false);
    let old = Journal::read(&f.setup.directory).unwrap();
    assert!(serde_json::to_value(old).unwrap()["records"][&r.reset_id]
        .get("lastFailure")
        .is_none());
    for invalid in [
        json!(""),
        json!("x".repeat(1001)),
        json!("bad\nmessage"),
        json!("bad\u{7f}message"),
        json!(7),
        json!({"raw": CANARY}),
    ] {
        let mut value = original.clone();
        value["records"][&r.reset_id]["lastFailure"] = invalid;
        save_journal(&f, &value, false);
        let error = Journal::read(&f.setup.directory).err().unwrap();
        assert!(!error.contains(CANARY));
        assert!(f.setup.restart_entry_allowed(&f.entry.id).is_err());
    }
}

#[test]
fn result_messages_are_preserved_only_after_state_identity_and_text_validation() {
    let f = fixture();
    let request = f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, false)
        .unwrap();
    let valid = json!({"schemaVersion":1,"resetId":request.reset_id,
        "operationId":request.binding.expected.operation_id,"environmentId":request.binding.expected.environment_id,
        "releaseId":request.binding.expected.release_id,"state":"failed","message":FAILURE});
    let result = parse_result(&serde_json::to_vec(&valid).unwrap(), &request).unwrap();
    assert_eq!(result.state, "failed");
    assert_eq!(result.message, FAILURE);
    for (field, value) in [
        ("schemaVersion", json!(2)),
        ("resetId", json!(PEER)),
        ("operationId", json!(PEER)),
        ("environmentId", json!(PEER)),
        ("releaseId", json!("other")),
        ("state", json!("none")),
        ("state", json!("prepared")),
        ("message", json!("")),
        ("message", json!(CANARY.repeat(100))),
        ("message", json!(format!("{CANARY}\n"))),
        ("message", json!(format!("{CANARY}\u{85}"))),
        ("message", json!(null)),
        ("stderr", json!(CANARY)),
    ] {
        let mut bad = valid.clone();
        bad[field] = value;
        let error = parse_result(&serde_json::to_vec(&bad).unwrap(), &request).unwrap_err();
        assert!(!error.contains(CANARY));
    }
    assert!(parse_result(CANARY.as_bytes(), &request).is_err());
    assert!(calls(&f).is_empty());
}

#[test]
fn invalid_result_or_transport_output_never_becomes_a_saved_failure() {
    for patch in [
        json!({"message":format!("{CANARY}\n")}),
        json!({"state":"none","message":CANARY}),
        json!({"resetId":PEER,"message":CANARY}),
    ] {
        let f = fixture();
        let registry = registry(&f);
        let review = review(&f, &f.entry.id);
        fs::write(
            f.root.join("result-patch.json"),
            serde_json::to_vec(&patch).unwrap(),
        )
        .unwrap();
        let result = apply(&f, &review, &registry);
        assert_eq!(result.state, "unknown");
        assert!(!result.message.contains(CANARY));
        assert!(journal_value(&f)["records"][&review.reset_id]
            .get("lastFailure")
            .is_none());
    }
    let (mut f, registry, r) = held();
    authorization_regressions::fail_server(&mut f, 1);
    let status = f
        .setup
        .restart_status(
            f.setup.reserve_restart_status(&f.entry.id).unwrap(),
            &registry,
        )
        .unwrap();
    assert!(status.message.contains(FAILURE));
    assert!(!status.message.contains("restart-auth-output-secret-canary"));
    assert_eq!(
        journal_value(&f)["records"][&r.reset_id]["lastFailure"],
        FAILURE
    );
}

#[test]
fn recovery_reuses_exact_hold_fresh_id_and_fence_with_two_separate_consents() {
    let (f, registry, held) = held();
    let original = journal_value(&f);
    let fresh = original["records"][&held.reset_id]["fresh"]["id"]
        .as_str()
        .unwrap();
    let before = saved_files(&f);
    let review = recovery_review(&f, &registry, &held.reset_id);
    assert_eq!(review.reset_id, held.reset_id);
    assert_eq!(
        saved_files(&f),
        before,
        "preparation may not replace local metadata"
    );
    let public = serde_json::to_string(&review).unwrap();
    let token = f.setup.inner.lock().unwrap().restart_reviews[0]
        .recovery_token
        .clone()
        .unwrap();
    assert!(recovery_token_valid(&token));
    assert!(!public.contains(&token));
    assert!(!public.contains("recoveryToken"));
    assert!(!public.contains("snapshotDigest"));
    assert!(!String::from_utf8(before.concat()).unwrap().contains(&token));
    let result = f
        .setup
        .restart_recovery_apply_with(
            recovery_apply(&f, &review),
            &registry,
            |entry, purpose, password, cancel| {
                assert_eq!(purpose, "apply");
                allow(entry, purpose, password, cancel)
            },
        )
        .unwrap();
    assert_eq!(result.state, "complete");
    assert_eq!(result.reset_id, held.reset_id);
    assert_eq!(result.entry.unwrap().id, fresh);
    let after = journal_value(&f);
    assert_eq!(after["records"].as_object().unwrap().len(), 1);
    for field in ["binding", "affected", "fresh", "createdAt"] {
        assert_eq!(
            after["records"][&held.reset_id][field],
            original["records"][&held.reset_id][field]
        );
    }
    let calls = calls(&f);
    assert_eq!(
        calls
            .iter()
            .map(|v| v["request"]["mode"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["review", "apply", "recover_review", "recover_apply"]
    );
    assert_eq!(calls[2]["request"].as_object().unwrap().len(), 3);
    assert_eq!(calls[3]["request"].as_object().unwrap().len(), 5);
    assert_eq!(calls[3]["request"]["recoveryToken"], token);
    for call in &calls[2..] {
        assert_eq!(call["request"]["resetId"], held.reset_id);
        assert_eq!(
            call["request"]["expected"],
            original["records"][&held.reset_id]["binding"]["expected"]
        );
        let args = serde_json::to_string(&call["args"]).unwrap();
        assert!(!args.contains(&token) && !args.contains("fixture-secret"));
    }
    assert!(registry.get(PEER).is_ok());
    assert!(f
        .setup
        .reserve_restart_recovery(&f.entry.id, &held.reset_id, false)
        .is_err());
    let status = f
        .setup
        .restart_status(
            f.setup.reserve_restart_status(&f.entry.id).unwrap(),
            &registry,
        )
        .unwrap();
    assert_eq!(status.entry.unwrap().id, fresh);
    assert_eq!(super::calls(&f).len(), calls.len());
}

#[test]
fn recovery_requires_a_fresh_review_and_normal_modes_refuse_its_cache_and_token() {
    let (f, registry, r) = held();
    assert!(f
        .setup
        .reserve_restart_recovery_apply(&f.entry.id, &r.review_id, &r.host, false)
        .is_err());
    let first = recovery_review(&f, &registry, &r.reset_id);
    let old = f.setup.inner.lock().unwrap().restart_reviews[0].clone();
    let second = recovery_review(&f, &registry, &r.reset_id);
    let current = f.setup.inner.lock().unwrap().restart_reviews[0].clone();
    assert_ne!(old.recovery_token, current.recovery_token);
    assert_ne!(old.snapshot_digest, current.snapshot_digest);
    assert!(f
        .setup
        .reserve_restart_recovery_apply(&f.entry.id, &first.review_id, &first.host, false)
        .is_err());
    assert!(f
        .setup
        .reserve_restart_recovery_apply(&f.entry.id, &second.review_id, "wrong-host", false)
        .is_err());
    let count = calls(&f).len();
    let apply = recovery_apply(&f, &second);
    let error = f
        .setup
        .restart_apply_with(apply, &registry, |_, _, _, _| {
            panic!("normal apply cannot prompt for a recovery cache")
        })
        .unwrap_err();
    assert!(error.contains("Recovery review"));
    assert_eq!(calls(&f).len(), count);
    let raw = fs::read(f.root.join("recovery-preparation.json")).unwrap();
    assert!(!raw.is_empty());
    let mut wire = json!({"recoveryToken":"a".repeat(64)});
    // The normal parser rejects the token even on an otherwise valid helper review.
    let request = f
        .setup
        .reserve_restart_recovery(&f.entry.id, &r.reset_id, false)
        .unwrap();
    let bytes = f
        .setup
        .call_restart_helper(&request, "review", None, Zeroizing::new(Vec::new()))
        .unwrap();
    let mut valid: Value = serde_json::from_slice(&bytes).unwrap();
    valid
        .as_object_mut()
        .unwrap()
        .append(wire.as_object_mut().unwrap());
    assert!(parse_review(&serde_json::to_vec(&valid).unwrap(), &request).is_err());
    assert!(f
        .setup
        .call_restart_helper_with_token(
            &request,
            "apply",
            Some(&"b".repeat(64)),
            Some(&"a".repeat(64)),
            Zeroizing::new(Vec::new())
        )
        .is_err());
}

#[test]
fn recovery_review_rejects_missing_malformed_or_foreign_token_and_identity() {
    for patch in [
        json!({"recoveryToken":null}),
        json!({"recoveryToken":"a".repeat(63)}),
        json!({"recoveryToken":"A".repeat(64)}),
        json!({"recoveryToken":"g".repeat(64)}),
        json!({"resetId":PEER}),
        json!({"operationId":PEER}),
        json!({"environmentId":PEER}),
        json!({"paths":["/home"]}),
        json!({"warnings":[format!("{CANARY}\n")]}),
    ] {
        let (f, registry, r) = held();
        let before = saved_files(&f);
        fs::write(
            f.root.join("review-patch.json"),
            serde_json::to_vec(&patch).unwrap(),
        )
        .unwrap();
        let error = f
            .setup
            .restart_recovery_review_with(
                f.setup
                    .reserve_restart_recovery(&f.entry.id, &r.reset_id, true)
                    .unwrap(),
                &registry,
                allow,
            )
            .unwrap_err();
        assert!(error.starts_with("[serverProtocol:recover_review]"));
        assert!(!error.contains(CANARY));
        assert!(f.setup.inner.lock().unwrap().restart_reviews.is_empty());
        assert_eq!(saved_files(&f), before);
    }
}

fn change_hold(f: &Fixture, reset: &str, problem: &str) {
    match problem {
        "journal-missing" => {
            fs::remove_file(f.setup.directory.join("restart-recovery/journal.json")).unwrap()
        }
        "journal-corrupt" => private_write(
            &f.setup.directory.join("restart-recovery/journal.json"),
            CANARY.as_bytes(),
        )
        .unwrap(),
        "record-missing" | "fresh" | "fresh-both" | "complete" | "ambiguous" | "memory" => {
            let mut value = journal_value(f);
            match problem {
                "record-missing" => {
                    value["records"].as_object_mut().unwrap().remove(reset);
                }
                "fresh" | "fresh-both" => {
                    value["records"][reset]["fresh"]["id"] = json!(Uuid::new_v4().to_string())
                }
                "complete" => value["records"][reset]["remoteComplete"] = json!(true),
                "ambiguous" => {
                    let id = Uuid::new_v4().to_string();
                    let mut other = value["records"][reset].clone();
                    other["resetId"] = json!(id);
                    value["records"][id] = other;
                }
                "memory" => {
                    f.setup
                        .inner
                        .lock()
                        .unwrap()
                        .restart_journal
                        .records
                        .clear();
                    return;
                }
                _ => unreachable!(),
            }
            save_journal(f, &value, problem == "fresh-both");
        }
        "affected" => {
            add(f, f.entry.clone());
        }
        "fence-unsafe" => fs::set_permissions(
            f.root.join("environments/restart-fences"),
            fs::Permissions::from_mode(0o777),
        )
        .unwrap(),
        "fence-missing" => {
            fs::remove_file(f.root.join("environments/restart-fences/journal.json")).unwrap()
        }
        "fence-mismatch" => private_write(
            &f.root.join("environments/restart-fences/journal.json"),
            br#"{"schemaVersion":1,"environments":[]}"#,
        )
        .unwrap(),
        "registry" => {
            let path = f.root.join("environments/registry.json");
            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            value["environments"][&f.entry.plan.as_ref().unwrap().environment_id]["ssh"]
                ["setupId"] = json!(PEER);
            private_write(&path, &serde_json::to_vec(&value).unwrap()).unwrap();
        }
        "pending-work" => {
            let path = f
                .root
                .join("environments")
                .join(&f.entry.plan.as_ref().unwrap().environment_id);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("pending.enc"), b"synthetic pending work").unwrap();
        }
        other => authorization_regressions::change_request(f, other),
    }
}

#[test]
fn recovery_revalidates_queued_and_post_consent_native_journal_fence_and_target() {
    for applying in [false, true] {
        for after_prompt in [false, true] {
            for problem in [
                "journal-missing",
                "journal-corrupt",
                "record-missing",
                "fresh",
                "fresh-both",
                "complete",
                "ambiguous",
                "memory",
                "affected",
                "fence-missing",
                "fence-unsafe",
                "fence-mismatch",
                "registry",
                "pending-work",
                "cancel",
                "token",
                "closed",
                "target",
                "pin",
            ] {
                let (f, registry, r) = held();
                let review = applying.then(|| recovery_review(&f, &registry, &r.reset_id));
                let request = if let Some(review) = &review {
                    Err(recovery_apply(&f, review))
                } else {
                    Ok(f.setup
                        .reserve_restart_recovery(&f.entry.id, &r.reset_id, true)
                        .unwrap())
                };
                let count = calls(&f).len();
                if !after_prompt {
                    change_hold(&f, &r.reset_id, problem);
                }
                let auth = |_: &Entry, _: &str, _: bool, _: &AtomicBool| {
                    assert!(after_prompt, "{problem} must fail before consent");
                    change_hold(&f, &r.reset_id, problem);
                    Ok(Zeroizing::new(b"fixture-secret\n".to_vec()))
                };
                let error = match request {
                    Ok(request) => f
                        .setup
                        .restart_recovery_review_with(request, &registry, auth)
                        .map(|_| ()),
                    Err(request) => f
                        .setup
                        .restart_recovery_apply_with(request, &registry, auth)
                        .map(|_| ()),
                }
                .unwrap_err();
                assert!(!error.contains(CANARY) && !error.contains("fixture-secret"));
                assert_eq!(calls(&f).len(), count, "{problem} dispatched");
                if problem == "token" {
                    f.setup.inner.lock().unwrap().activities.clear();
                }
            }
        }
    }
}

#[test]
fn recovery_cancel_and_authorization_failures_never_mutate_or_dispatch() {
    for applying in [false, true] {
        for error in [
            AuthorizationError::UserCancel,
            AuthorizationError::Timeout,
            AuthorizationError::Unavailable,
            AuthorizationError::InvalidResponse,
            AuthorizationError::RequestCancel,
        ] {
            let (f, registry, r) = held();
            let review = applying.then(|| recovery_review(&f, &registry, &r.reset_id));
            let before = saved_files(&f);
            let count = calls(&f).len();
            let result = if let Some(review) = review {
                f.setup
                    .restart_recovery_apply_with(
                        recovery_apply(&f, &review),
                        &registry,
                        |_, mode, _, _| {
                            assert_eq!(mode, "apply");
                            Err(error)
                        },
                    )
                    .map(|_| ())
            } else {
                f.setup
                    .restart_recovery_review_with(
                        f.setup
                            .reserve_restart_recovery(&f.entry.id, &r.reset_id, true)
                            .unwrap(),
                        &registry,
                        |_, mode, _, _| {
                            assert_eq!(mode, "recover_review");
                            Err(error)
                        },
                    )
                    .map(|_| ())
            };
            assert_eq!(result.unwrap_err(), error.to_string());
            assert_eq!(calls(&f).len(), count);
            assert_eq!(saved_files(&f), before);
            assert!(f.setup.inner.lock().unwrap().activities.is_empty());
        }
    }
}

#[test]
fn recovery_review_expiry_before_and_during_removal_consent_never_dispatches() {
    for during_prompt in [false, true] {
        let (f, registry, r) = held();
        let review = recovery_review(&f, &registry, &r.reset_id);
        let mut apply = recovery_apply(&f, &review);
        apply.cached.review.expires_at = if during_prompt { now() + 100 } else { 0 };
        let count = calls(&f).len();
        let before = saved_files(&f);
        let error = f
            .setup
            .restart_recovery_apply_with(apply, &registry, |_, mode, _, _| {
                assert!(during_prompt);
                assert_eq!(mode, "apply");
                std::thread::sleep(Duration::from_millis(150));
                Ok(Zeroizing::new(b"fixture-secret\n".to_vec()))
            })
            .unwrap_err();
        assert!(error.contains("expired"));
        assert_eq!(calls(&f).len(), count);
        assert_eq!(saved_files(&f), before);
    }
}

#[test]
fn stale_remote_preparation_and_intent_never_promote_a_late_request() {
    let (f, registry, r) = held();
    let review = recovery_review(&f, &registry, &r.reset_id);
    let request = recovery_apply(&f, &review);
    let path = f.root.join("recovery-preparation.json");
    let mut preparation: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    preparation["recoveryToken"] = json!("0".repeat(64));
    fs::write(&path, serde_json::to_vec(&preparation).unwrap()).unwrap();
    let result = f
        .setup
        .restart_recovery_apply_with(request, &registry, allow)
        .unwrap();
    assert_eq!(result.state, "unknown");
    assert!(result.message.contains(FAILURE));
    assert!(!f.root.join("recovery-intent").exists());
    fs::write(f.root.join("recovery-intent"), b"existing intent").unwrap();
    let before = saved_files(&f);
    let blocked = f
        .setup
        .restart_recovery_review_with(
            f.setup
                .reserve_restart_recovery(&f.entry.id, &r.reset_id, true)
                .unwrap(),
            &registry,
            allow,
        )
        .unwrap();
    assert!(!blocked.can_reset);
    assert_eq!(
        blocked.blockers,
        ["Recovery preparation contains deletion intent; no replay allowed."]
    );
    assert!(f
        .setup
        .reserve_restart_recovery_apply(&f.entry.id, &blocked.review_id, &blocked.host, true)
        .is_err());
    assert_eq!(saved_files(&f), before);
}

#[test]
fn recovery_reservation_refuses_absent_wrong_or_ambiguous_held_identity() {
    let f = fixture();
    assert!(f
        .setup
        .reserve_restart_recovery(&f.entry.id, &Uuid::new_v4().to_string(), false)
        .is_err());
    assert!(calls(&f).is_empty());
    let (f, _, r) = held();
    assert!(f
        .setup
        .reserve_restart_recovery(&f.entry.id, PEER, false)
        .is_err());
    let other = add(&f, f.entry.clone());
    assert!(f
        .setup
        .reserve_restart_recovery(&other, &r.reset_id, false)
        .is_err());
    let mut value = journal_value(&f);
    let mut duplicate = value["records"][&r.reset_id].clone();
    duplicate["resetId"] = json!(PEER);
    value["records"][PEER] = duplicate;
    save_journal(&f, &value, true);
    assert!(f
        .setup
        .reserve_restart_recovery(&f.entry.id, &r.reset_id, false)
        .is_err());
    assert_eq!(calls(&f).len(), 2);
}

#[test]
fn a_registry_changed_since_recovery_review_requires_new_consent_even_if_disk_matches_memory() {
    let (f, registry, r) = held();
    let review = recovery_review(&f, &registry, &r.reset_id);
    let path = f.root.join("environments/registry.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["environments"][&review.environment_id]["ssh"]["generation"] = json!(99);
    private_write(&path, &serde_json::to_vec(&value).unwrap()).unwrap();
    let changed =
        environments::Registry::new(f.root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    let count = calls(&f).len();
    let before = saved_files(&f);
    let error = f
        .setup
        .restart_recovery_apply_with(recovery_apply(&f, &review), &changed, |_, _, _, _| {
            panic!("changed registry must not prompt")
        })
        .unwrap_err();
    assert!(error.contains("since recovery review"));
    assert_eq!(calls(&f).len(), count);
    assert_eq!(saved_files(&f), before);
}

#[test]
fn late_original_apply_cannot_get_consent_or_replace_an_existing_hold() {
    let f = fixture();
    let registry = registry(&f);
    let review = review(&f, &f.entry.id);
    let apply = f
        .setup
        .reserve_restart_apply(&f.entry.id, &review.review_id, &review.host, false)
        .unwrap();
    let pending = f.setup.prepare_restart(&apply.request).unwrap();
    let fence = registry
        .reserve_restart_fence(&review.environment_id)
        .unwrap();
    registry
        .commit_restart_fence(&fence, &pending.affected)
        .unwrap();
    f.setup.pause_restart_entries(&pending).unwrap();
    drop(fence);
    let before = saved_files(&f);
    let count = calls(&f).len();
    let error = f
        .setup
        .restart_apply_with(apply, &registry, |_, _, _, _| {
            panic!("late original approval must not prompt")
        })
        .unwrap_err();
    assert_eq!(error, HOLD);
    assert_eq!(calls(&f).len(), count);
    assert_eq!(saved_files(&f), before);
    let recovery = recovery_review(&f, &registry, &review.reset_id);
    let request = f
        .setup
        .reserve_restart_recovery(&f.entry.id, &review.reset_id, false)
        .unwrap();
    let result = f
        .setup
        .call_restart_helper(
            &request,
            "apply",
            Some(&"b".repeat(64)),
            Zeroizing::new(Vec::new()),
        )
        .unwrap();
    assert_eq!(parse_result(&result, &request).unwrap().state, "unknown");
    assert!(!f.root.join("recovery-intent").exists());
    assert_eq!(recovery.reset_id, review.reset_id);
}

#[test]
fn root_recovery_still_requires_both_consents_without_sudo_or_password() {
    let f = fixture();
    let registry = registry(&f);
    {
        let mut inner = f.setup.inner.lock().unwrap();
        inner.entries.get_mut(&f.entry.id).unwrap().inspection = Some(
            serde_json::from_value(json!({
                "version":1,"os":"ubuntu","osVersion":"24.04","architecture":"x86_64",
                "systemd":true,"uid":0,"freeBytes":20000000000_u64,"memoryBytes":4000000000_u64,
                "markers":[],"container":false,"sudo":"root","api":"absent","environment":null
            }))
            .unwrap(),
        );
        f.setup.persist(&inner).unwrap();
    }
    fs::write(f.root.join("apply-failed"), b"").unwrap();
    let review = review(&f, &f.entry.id);
    assert_eq!(apply(&f, &review, &registry).state, "failed");
    fs::remove_file(f.root.join("apply-failed")).unwrap();
    let review = f
        .setup
        .restart_recovery_review_with(
            f.setup
                .reserve_restart_recovery(&f.entry.id, &review.reset_id, true)
                .unwrap(),
            &registry,
            |_, mode, password, _| {
                assert_eq!(mode, "recover_review");
                assert!(!password);
                Ok(Zeroizing::new(Vec::new()))
            },
        )
        .unwrap();
    let result = f
        .setup
        .restart_recovery_apply_with(
            recovery_apply(&f, &review),
            &registry,
            |_, mode, password, _| {
                assert_eq!(mode, "apply");
                assert!(!password);
                Ok(Zeroizing::new(Vec::new()))
            },
        )
        .unwrap();
    assert_eq!(result.state, "complete");
    assert!(calls(&f)
        .iter()
        .all(|c| !serde_json::to_string(&c["args"]).unwrap().contains("sudo ")));
}

#[test]
fn post_dispatch_local_journal_change_is_never_overwritten_by_recovery_completion() {
    let (f, registry, r) = held();
    let review = recovery_review(&f, &registry, &r.reset_id);
    fs::write(f.root.join("break-journal"), b"").unwrap();
    let result = f
        .setup
        .restart_recovery_apply_with(recovery_apply(&f, &review), &registry, allow)
        .unwrap();
    assert_eq!(result.state, "unknown");
    assert!(result.message.contains(FAILURE));
    assert!(f
        .setup
        .directory
        .join("restart-recovery/journal.json")
        .is_dir());
    assert!(!f.setup.inner.lock().unwrap().restart_journal.records[&r.reset_id].remote_complete);
    assert!(f.setup.restart_entry_allowed(&f.entry.id).is_err());
}

#[test]
fn lost_recovery_reply_is_same_id_status_only_and_mismatched_completion_stays_held() {
    for mismatch in [false, true] {
        let (f, registry, r) = held();
        let fresh = journal_value(&f)["records"][&r.reset_id]["fresh"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let review = recovery_review(&f, &registry, &r.reset_id);
        fs::write(
            f.root.join(if mismatch { "wrong-outcome" } else { "lost" }),
            b"",
        )
        .unwrap();
        let result = f
            .setup
            .restart_recovery_apply_with(recovery_apply(&f, &review), &registry, allow)
            .unwrap();
        assert_eq!(result.state, "unknown");
        assert!(result.message.contains(FAILURE));
        assert!(f.setup.entry(&fresh).is_err());
        assert!(f
            .setup
            .reserve_restart_recovery_apply(&f.entry.id, &review.review_id, &review.host, true)
            .is_err());
        fs::write(f.root.join("remote-complete"), b"").unwrap();
        let mut reopened = Setup::new(f.root.clone()).unwrap();
        reopened.ssh_fixture = f.setup.ssh_fixture.clone();
        let result = reopened
            .restart_status(
                reopened.reserve_restart_status(&f.entry.id).unwrap(),
                &registry,
            )
            .unwrap();
        assert_eq!(result.state, "complete");
        assert_eq!(result.reset_id, r.reset_id);
        assert_eq!(result.entry.unwrap().id, fresh);
        assert_eq!(
            calls(&f)
                .iter()
                .filter(|c| c["request"]["mode"] == "recover_apply")
                .count(),
            1
        );
    }
}
